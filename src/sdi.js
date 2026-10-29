/**
 * MaidenPlayer — SDI Output (Blackmagic DeckLink / UltraStudio)
 *
 * Sends frame-accurate playback out of a Blackmagic device to a projector or
 * reference monitor, so a screening room can be set up and checked without a
 * paid seat in another application.
 *
 * WHY THIS DOES NOT REUSE THE NORMAL PLAYBACK PATH
 *
 * An image sequence is normally rendered to H.264 at CRF 18 in yuv420p and
 * played in the <video> element. That is fine on a desktop and wrong down an
 * SDI cable: an 8-bit, chroma-subsampled proxy on a VFX projector would have
 * people drawing conclusions about a float render from a picture that cannot
 * represent it. So SDI decodes the source directly to 10-bit 4:2:2 and never
 * touches the proxy:
 *
 *   EXR / DPX / ProRes → ffmpeg (v210, 10-bit 4:2:2) → sdi-out → DeckLink → SDI
 *                               (PCM, 48 kHz 16-bit) ↗  on a second pipe
 *
 * v210 is the DeckLink-native pixel format (bmdFormat10BitYUV), so frames
 * reach the card with no conversion. Sound travels beside the picture, not
 * inside it: the same ffmpeg writes the clip's audio as raw PCM on a second
 * output pipe, the helper reads it on fd 4 and schedules it against the same
 * clock as the frames, and the card embeds it in the SDI stream. One decoder
 * for both means they can never start from different places in the clip.
 *
 * WHY THE CLOCK LIVES IN A SEPARATE PROCESS
 *
 * Frame accuracy is the whole point, and Electron's main thread also runs IPC,
 * the menus, the auto-updater and garbage collection. A hard real-time
 * schedule sharing that thread drops frames. A separate process also means a
 * driver fault cannot take the player down in the middle of a screening.
 *
 * The native helper lives in native/sdi-out/ and is built for macOS and
 * Windows in CI from the committed DeckLink SDK headers (see its README).
 * Everything in this module that does not need the helper is implemented and
 * tested; device control reports plainly when it is absent.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { FFMPEG } = require('./transcoder');
const { lutFilter } = require('./editor');

const MISSING_HELPER_MESSAGE =
  'SDI output is not installed in this build.\n\n' +
  'Sending video to a Blackmagic device needs the sdi-out helper, which is ' +
  'built from Blackmagic\'s Desktop Video SDK.\n\n' +
  'Normal playback is unaffected.';

// ---------------------------------------------------------------------------
// v210 geometry
//
// v210 packs 6 pixels into 16 bytes, then pads each row to a 128-byte
// boundary. The padding is the part that bites: DCI widths are not multiples
// of 6, so a row is WIDER than width/6*16 — 4096 pixels is 11,008 bytes, not
// 10,912. Treating the frame as contiguous at the arithmetic size puts a
// shear across the image on a DCI projector.
//
// Verified against ffmpeg's own v210 encoder at 720, 1280, 1920, 2048, 3840,
// 4096, 5120 and 6144 wide: this formula matches its output byte for byte,
// and it is the same one Blackmagic document for GetRowBytes().
// ---------------------------------------------------------------------------

const V210_ROW_ALIGNMENT = 128;
const V210_PIXELS_PER_BLOCK = 48;

/** Bytes in one row of a v210 frame this wide. */
function v210RowBytes(width) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new RangeError('v210RowBytes: width must be a positive integer, got ' + width);
  }
  return Math.floor((width + V210_PIXELS_PER_BLOCK - 1) / V210_PIXELS_PER_BLOCK) * V210_ROW_ALIGNMENT;
}

/** Bytes in one whole v210 frame. */
function v210FrameBytes(width, height) {
  if (!Number.isInteger(height) || height <= 0) {
    throw new RangeError('v210FrameBytes: height must be a positive integer, got ' + height);
  }
  return v210RowBytes(width) * height;
}

// ---------------------------------------------------------------------------
// Output modes
//
// Only the rates a screening room actually runs. `deckLinkMode` is the
// BMDDisplayMode the helper resolves; keeping the mapping here means the
// player never handles an SDK enum, the same way src/braw.js keeps FFmpeg
// pixel-format names out of the SDK.
// ---------------------------------------------------------------------------

// Rasters and rates are built as a table rather than written out one by one:
// it is 30-odd combinations, and a hand-written list of that size is where a
// transposed digit hides.
const RASTERS = [
  { key: '4kdci',  label: '4K DCI', width: 4096, height: 2160, deckLink: 'bmdMode4kDCI' },
  { key: 'uhd',    label: 'UHD',    width: 3840, height: 2160, deckLink: 'bmdMode4K2160p' },
  { key: '2kdci',  label: '2K DCI', width: 2048, height: 1080, deckLink: 'bmdMode2kDCI' },
  { key: 'hd1080', label: 'HD',     width: 1920, height: 1080, deckLink: 'bmdModeHD1080p' },
  { key: 'hd720',  label: 'HD',     width: 1280, height: 720,  deckLink: 'bmdModeHD720p' },
];

const RATES = [
  { key: '2398', fps: 23.976, rational: '24000/1001', label: '23.98p' },
  { key: '24',   fps: 24,     rational: '24/1',        label: '24p' },
  { key: '25',   fps: 25,     rational: '25/1',        label: '25p' },
  { key: '2997', fps: 29.97,  rational: '30000/1001', label: '29.97p' },
  { key: '30',   fps: 30,     rational: '30/1',        label: '30p' },
  { key: '50',   fps: 50,     rational: '50/1',        label: '50p' },
  { key: '5994', fps: 59.94,  rational: '60000/1001', label: '59.94p' },
  { key: '60',   fps: 60,     rational: '60/1',        label: '60p' },
];

// Which rates each raster is offered at. 720p has never had the cinema rates,
// and the high rates at 4K need 12G-SDI — whether THIS card can do a given
// mode is answered by the device itself (see matchModeForSource's `supported`
// argument), not guessed at here.
const RATES_BY_RASTER = {
  '4kdci':  ['2398', '24', '25', '2997', '30', '50', '5994', '60'],
  'uhd':    ['2398', '24', '25', '2997', '30', '50', '5994', '60'],
  '2kdci':  ['2398', '24', '25', '2997', '30'],
  'hd1080': ['2398', '24', '25', '2997', '30', '50', '5994', '60'],
  'hd720':  ['50', '5994', '60'],
};

const MODES = [];
for (const raster of RASTERS) {
  for (const rateKey of RATES_BY_RASTER[raster.key]) {
    const rate = RATES.find((r) => r.key === rateKey);
    MODES.push({
      name: raster.key + 'p' + rate.key,
      label: raster.label + ' ' + raster.width + 'x' + raster.height + ' ' + rate.label,
      width: raster.width,
      height: raster.height,
      fps: rate.fps,
      fpsRational: rate.rational,
      // A HINT for the helper, not the authority. The helper resolves the
      // actual BMDDisplayMode by asking the card which modes it supports and
      // matching on raster plus rate, because these enum names vary between
      // SDK versions and a stale one would fail at output time.
      // One irregularity in Blackmagic's naming: 1080p60 is bmdModeHD1080p6000,
      // every other 60p mode is plain p60. It is only a hint (the helper asks
      // the card), but a correct hint is a cheaper lookup.
      deckLinkMode: raster.deckLink + (raster.key === 'hd1080' && rate.key === '60' ? '6000' : rate.key),
    });
  }
}

function findMode(name) {
  return MODES.find((m) => m.name === name) || null;
}

/**
 * Pick the closest output mode for a source.
 *
 * Exact geometry wins; otherwise the smallest mode that still contains the
 * source, so the image is letterboxed rather than cropped — losing framing on
 * a review projector is worse than bars. Frame rate is matched first, because
 * a rate mismatch means judder no amount of scaling fixes.
 *
 * @param {{width:number,height:number,fps:number}} source
 * @returns {object|null}
 */
/**
 * Pick the best of `candidates` for a source. Shared by matchModeForSource
 * (the static table) and chooseDeviceMode (what a card actually reports).
 */
function pickMode(candidates, source) {
  if (!candidates || !candidates.length || !source || !source.width || !source.height) return null;

  const RATE_EPSILON = 0.01;
  const delta = (m) => Math.abs(m.fps - source.fps);

  let pool = candidates;
  if (source.fps) {
    pool = candidates.filter((m) => delta(m) <= RATE_EPSILON);
    if (!pool.length) {
      const nearest = candidates.reduce((b, m) => (delta(m) < delta(b) ? m : b), candidates[0]);
      pool = candidates.filter((m) => Math.abs(m.fps - nearest.fps) <= RATE_EPSILON);
      console.warn('[SDI] No output mode runs at ' + source.fps +
                   ' fps; nearest is ' + nearest.fps + ' fps, which will judder');
    }
  }

  const exact = pool.find((m) => m.width === source.width && m.height === source.height);
  if (exact) return exact;
  const containing = pool
    .filter((m) => m.width >= source.width && m.height >= source.height)
    .sort((a, b) => (a.width * a.height) - (b.width * b.height));
  if (containing.length) return containing[0];
  return pool.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
}

/**
 * Choose an output mode from what a connected device reports it can do —
 * the authoritative list, since it came from the hardware.
 * @param {{modes: Array}} device  An entry from listDevices().
 */
function chooseDeviceMode(device, source) {
  return pickMode(device && device.modes, source);
}

function matchModeForSource(source, supported) {
  if (!source || !source.width || !source.height) return null;

  // When the device has told us what it can do, never offer anything else —
  // scheduling an unsupported mode fails at the card, after playback has
  // apparently started.
  const available = (Array.isArray(supported) && supported.length)
    ? MODES.filter((m) => supported.includes(m.name) || supported.includes(m.deckLinkMode))
    : MODES;
  if (!available.length) return null;

  // The tolerance has to be TIGHTER than the gap between 23.976 and 24, which
  // is 0.024. A looser window treats them as the same rate, and a 24p sequence
  // sent out at 23.98 judders — one dropped frame roughly every 42 seconds,
  // which is precisely the sort of fault a screening-room check exists to
  // catch. Match only a genuinely equal rate; otherwise take the nearest, and
  // never silently blend the two.
  const RATE_EPSILON = 0.01;
  const delta = (m) => Math.abs(m.fps - source.fps);

  let pool = available;
  if (source.fps) {
    pool = available.filter((m) => delta(m) <= RATE_EPSILON);
    if (!pool.length) {
      const nearest = available.reduce((best, m) => (delta(m) < delta(best) ? m : best), available[0]);
      pool = available.filter((m) => Math.abs(m.fps - nearest.fps) <= RATE_EPSILON);
      console.warn('[SDI] No output mode runs at ' + source.fps +
                   ' fps; nearest is ' + nearest.fps + ' fps, which will judder');
    }
  }

  const exact = pool.find((m) => m.width === source.width && m.height === source.height);
  if (exact) return exact;

  const containing = pool
    .filter((m) => m.width >= source.width && m.height >= source.height)
    .sort((a, b) => (a.width * a.height) - (b.width * b.height));
  if (containing.length) return containing[0];

  // Source is larger than anything on offer — take the biggest and scale down.
  return pool.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0] || null;
}

// ---------------------------------------------------------------------------
// Sound
//
// SDI embeds 48 kHz PCM in groups: a device carries 2, 8 or 16 channels and
// nothing in between, so a 5.1 master goes out as 8 with two empty, and a
// mono guide track is put on both sides of the room. Channels are laid into
// the embed in source order and never mixed — on a review projector the
// question is "is the Ls where it should be", and a downmix cannot answer it.
// Samples are 16-bit integer unless asked otherwise (see audioDepth).
// ---------------------------------------------------------------------------

const AUDIO_RATE = 48000;

/**
 * Bits per sample sent to the card. 16 by default: it is what ffmpeg's own
 * DeckLink output and every Blackmagic sample use, the most exercised path
 * through the driver, and more than a review room can hear. 32 carries a
 * 24-bit master without loss; MAIDENPLAYER_SDI_AUDIO_DEPTH=32 asks for it.
 */
function audioDepth() {
  return process.env.MAIDENPLAYER_SDI_AUDIO_DEPTH === '32' ? 32 : 16;
}

/**
 * Channels to embed for a source with `total` channels on a device that
 * carries up to `deviceMax`. 0 means no sound.
 */
function audioOutputChannels(total, deviceMax) {
  if (!Number.isFinite(total) || total < 1) return 0;
  const want = total <= 2 ? 2 : total <= 8 ? 8 : 16;
  // An unreported maximum means stereo — the one count every output has.
  const max = deviceMax >= 16 ? 16 : deviceMax >= 8 ? 8 : 2;
  return Math.min(want, max);
}

/**
 * What sound to send with a source, from the playback probe, or null when
 * the source has none. Image sequences have none by nature.
 *
 * @param {{audioStreamCount?:number, audioChannelsTotal?:number}|null} probe
 * @param {{maxAudioChannels?:number}|null} device  An entry from listDevices().
 * @returns {{streams:number, channels:number, outChannels:number}|null}
 */
function planAudio(probe, device) {
  if (!probe) return null;
  const streams = Math.max(0, probe.audioStreamCount | 0);
  const channels = Math.max(0, probe.audioChannelsTotal | 0);
  if (streams < 1 || channels < 1) return null;
  const outChannels = audioOutputChannels(channels, device ? device.maxAudioChannels : 0);
  if (!outChannels) return null;
  return { streams, channels, outChannels, depth: audioDepth() };
}

/**
 * ffmpeg filter laying the source channels into the first slots of an
 * `outChannels`-wide embed, in order, with no mixing. Mono is doubled.
 */
function audioLayoutFilter(channels, outChannels) {
  const maps = [];
  if (channels === 1) {
    maps.push('c0=c0', 'c1=c0');
  } else {
    for (let i = 0; i < Math.min(channels, outChannels); i++) maps.push('c' + i + '=c' + i);
  }
  return 'pan=' + outChannels + 'c|' + maps.join('|');
}

/**
 * The audio half of the filter chain. aresample pins the sound to the
 * timeline: first_pts=0 pads silence when a track starts late, and async=1
 * fills or trims around gaps in its timestamps without stretching — so
 * sample N is always at N/48000 s from where playback started, which is the
 * contract the helper schedules against.
 */
function audioFilter(audio) {
  return 'aresample=' + AUDIO_RATE + ':async=1:first_pts=0,' + audioLayoutFilter(audio.channels, audio.outChannels);
}

/**
 * Filtergraph fragment that yields input `i`'s sound as one stream. Masters
 * routinely carry audio as discrete mono tracks (a pair as two monos, 5.1 as
 * six); ffmpeg's default selection would keep only one, so they are merged
 * into a single stream with each track as its own channel, as the desktop
 * player does.
 */
function audioSource(i, audio) {
  if (audio.streams > 1) {
    const inputs = Array.from({ length: audio.streams }, (_, k) => '[' + i + ':a:' + k + ']').join('');
    return { graph: inputs + 'amerge=inputs=' + audio.streams + '[a' + i + 'm]', label: '[a' + i + 'm]' };
  }
  return { graph: null, label: '[' + i + ':a:0]' };
}

// ---------------------------------------------------------------------------
// Decode to v210
// ---------------------------------------------------------------------------

/**
 * Build the ffmpeg arguments that feed the SDI helper.
 *
 * Scaling and padding happen here rather than in the helper so the bytes
 * arriving at the card are already the exact geometry the mode wants; the
 * helper then only has to respect the row stride.
 *
 * @param {object} opts
 * @param {string} opts.source          File path, or an image-sequence pattern.
 * @param {object} opts.mode            One of MODES.
 * @param {boolean} [opts.isImageSequence]
 * @param {number} [opts.startFrame]    Image sequences only — frame to start FROM.
 * @param {number} [opts.firstFrame]    Image sequences only — where the sequence BEGINS,
 *                                      so a loop can return to it. Defaults to startFrame.
 * @param {number} [opts.startTime]     Everything else — seek position in seconds.
 * @param {boolean} [opts.loop]
 * @param {string}  [opts.lut]          Path to a .cube LUT to apply to the output picture.
 * @param {object}  [opts.audio]        From planAudio(). When present the sound goes out as
 *                                      raw PCM on ffmpeg's fd 3, beside the frames on stdout.
 * @returns {string[]}
 */
function buildDecodeArgs(opts) {
  const { source, mode } = opts;
  if (!source) throw new Error('buildDecodeArgs: source is required');
  if (!mode) throw new Error('buildDecodeArgs: mode is required');
  const audio = (opts.audio && opts.audio.outChannels > 0) ? opts.audio : null;

  // Fit to the mode without cropping or stretching: scale to fit, then pad to
  // the exact raster. force_original_aspect_ratio keeps the framing intact.
  // An optional .cube LUT (ffmpeg lut3d, tetrahedral) goes in after the fit
  // and before the final format conversion, so a review projector shows the
  // same look as the desktop. See editor.lutFilter for the path escaping.
  const lut = opts.lut ? lutFilter(opts.lut) + ',' : '';
  const fit =
    'scale=' + mode.width + ':' + mode.height + ':force_original_aspect_ratio=decrease,' +
    'pad=' + mode.width + ':' + mode.height + ':(ow-iw)/2:(oh-ih)/2,' +
    lut +
    'format=yuv422p10le';

  // The input, from the current position.
  const fromHere = [];
  if (opts.isImageSequence) {
    // The rate has to be declared: a sequence of stills carries none.
    fromHere.push('-framerate', mode.fpsRational);
    if (opts.startFrame !== undefined) fromHere.push('-start_number', String(opts.startFrame));
  } else if (opts.startTime > 0) {
    fromHere.push('-ss', String(opts.startTime));
  }
  fromHere.push('-i', source);

  // Loop playback belongs to ffmpeg, not the helper: -stream_loop re-reads the
  // input seamlessly, so the card sees one continuous stream and nothing has
  // to hold a clip in memory — at 4K DCI that would be 24 MB a frame.
  //
  // But -stream_loop returns to where ITS input began — the -ss or
  // -start_number above — so Loop switched on mid-clip would repeat from that
  // point forever. When playback is not at the start, the clip is therefore
  // two inputs joined by the concat filter: the remainder from here, then the
  // whole clip looping. Checked frame by frame on ffmpeg 6.1 and 9.0: a
  // sequence started at frame 5 plays 5…10, then 1…10, 1…10, and the v210
  // byte count through the full scale/pad chain is whole frames exactly.
  const atStart = opts.isImageSequence
    ? (opts.startFrame === undefined || opts.firstFrame === undefined || opts.startFrame <= opts.firstFrame)
    : !(opts.startTime > 0);

  const args = [];
  if (!audio) {
    if (!opts.loop) {
      args.push(...fromHere, '-vf', fit);
    } else if (atStart) {
      args.push('-stream_loop', '-1', ...fromHere, '-vf', fit);
    } else {
      const fromStart = ['-stream_loop', '-1'];
      if (opts.isImageSequence) fromStart.push('-framerate', mode.fpsRational, '-start_number', String(opts.firstFrame));
      fromStart.push('-i', source);
      args.push(...fromHere, ...fromStart, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,' + fit);
    }
    args.push('-r', mode.fpsRational);

    // v210 is what the card takes natively, so this is the last conversion.
    args.push('-c:v', 'v210', '-an', '-f', 'rawvideo', 'pipe:1');
    return args;
  }

  // With sound, picture and sound are two outputs of ONE decode, so a seek
  // or a loop lands both at the same sample. Everything goes through one
  // filtergraph: the picture chain as above, the sound merged (if discrete),
  // pinned to the timeline and laid into the embed.
  const graph = [];
  if (!opts.loop || atStart) {
    if (opts.loop) args.push('-stream_loop', '-1');
    args.push(...fromHere);
    const a0 = audioSource(0, audio);
    graph.push('[0:v]' + fit + '[v]');
    if (a0.graph) graph.push(a0.graph);
    graph.push(a0.label + audioFilter(audio) + '[a]');
  } else {
    // Mid-clip loop: the remainder from here, then the whole clip forever —
    // joined for sound and picture together, so the join is at the same
    // instant in both.
    const fromStart = ['-stream_loop', '-1', '-i', source];
    args.push(...fromHere, ...fromStart);
    const a0 = audioSource(0, audio);
    const a1 = audioSource(1, audio);
    if (a0.graph) graph.push(a0.graph);
    if (a1.graph) graph.push(a1.graph);
    graph.push('[0:v]' + a0.label + '[1:v]' + a1.label + 'concat=n=2:v=1:a=1[vc][ac]');
    graph.push('[vc]' + fit + '[v]');
    graph.push('[ac]' + audioFilter(audio) + '[a]');
  }
  args.push('-filter_complex', graph.join(';'));

  // Two outputs, each with its own map: v210 on stdout as before, and the
  // sound as raw integer PCM on fd 3 — which the helper reads on ITS fd 4.
  const pcm = (audio.depth === 32) ? 's32le' : 's16le';
  args.push('-map', '[v]', '-r', mode.fpsRational, '-c:v', 'v210', '-f', 'rawvideo', 'pipe:1');
  args.push('-map', '[a]', '-c:a', 'pcm_' + pcm, '-f', pcm, 'pipe:3');
  return args;
}

/**
 * Spawn ffmpeg producing v210 frames on stdout — and, when opts.audio is
 * set, PCM on stdio[3]. ffmpeg's pipe: protocol writes to any inherited fd
 * on macOS and Windows alike (checked: Node's extra 'pipe' slot reaches a
 * Windows ffmpeg as CRT fd 3 the same way the helper sees its control pipe).
 */
function spawnDecoder(opts) {
  const args = buildDecodeArgs(opts);
  console.log('[SDI] Decoding:', FFMPEG, args.join(' '));
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (opts.audio && opts.audio.outChannels > 0) stdio.push('pipe');
  return spawn(FFMPEG, args, { windowsHide: true, stdio });
}

// ---------------------------------------------------------------------------
// The native helper
// ---------------------------------------------------------------------------

function getHelperPath() {
  const override = process.env.MAIDENPLAYER_SDI_OUT;
  if (override) return override;

  const exe = process.platform === 'win32' ? 'sdi-out.exe' : 'sdi-out';
  const binDir = path.join(__dirname, 'bin');
  const binDirUnpacked = binDir.includes('app.asar')
    ? binDir.replace('app.asar', 'app.asar.unpacked')
    : binDir;

  const candidates = [path.join(binDirUnpacked, exe), path.join(binDir, exe)];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'bin', exe));

  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) return fp;
    } catch (_) { /* ignore */ }
  }
  return null;
}

let cachedHelper;
let helperResolved = false;

function helperPath() {
  if (!helperResolved) {
    cachedHelper = getHelperPath();
    helperResolved = true;
    console.log('[SDI] Helper:', cachedHelper || 'not present — SDI output unavailable');
  }
  return cachedHelper;
}

function isAvailable() {
  return helperPath() !== null;
}

/**
 * List the Blackmagic devices attached to this machine.
 *
 * Resolves to [] when no helper is built or no device is connected — an empty
 * list is a normal answer, not an error, so the UI can say "no device found"
 * without a failure path.
 *
 * @returns {Promise<Array<{index:number,name:string,modes:string[]}>>}
 */
/**
 * Run the helper's enumeration and keep EVERYTHING it said.
 *
 * "No device found" is one symptom with several causes — helper crashed,
 * API failed to load, driver reports nothing — and a bare empty array hides
 * which. This resolves (never rejects) with the devices plus the raw stdout,
 * stderr, exit code and helper path, so the app can show a diagnostics dialog
 * a person can screenshot.
 *
 * @returns {Promise<{devices:Array, stdout:string, stderr:string, code:number|null,
 *                    signal:string|null, error:string|null, helper:string|null}>}
 */
function listDevicesDetailed() {
  return new Promise((resolve) => {
    const helper = helperPath();
    const result = { devices: [], stdout: '', stderr: '', code: null, signal: null, error: null, helper };
    if (!helper) {
      result.error = MISSING_HELPER_MESSAGE;
      resolve(result);
      return;
    }

    let proc;
    try {
      proc = spawn(helper, ['--list-devices'], { windowsHide: true });
    } catch (err) {
      result.error = 'Could not run the SDI helper: ' + err.message;
      resolve(result);
      return;
    }
    proc.stdout.on('data', (d) => { result.stdout += d.toString(); });
    proc.stderr.on('data', (d) => { result.stderr += d.toString(); });
    proc.on('error', (err) => {
      result.error = 'Could not run the SDI helper: ' + err.message;
      resolve(result);
    });
    proc.on('close', (code, signal) => {
      result.code = code;
      result.signal = signal;
      if (code !== 0) {
        result.error = signal
          ? 'sdi-out was killed by ' + signal + ' (a crash inside the helper or the DeckLink API)'
          : (result.stderr.trim().split('\n').pop() || 'sdi-out exited with code ' + code);
        resolve(result);
        return;
      }
      try {
        const parsed = JSON.parse(result.stdout);
        result.devices = Array.isArray(parsed) ? parsed : (parsed.devices || []);
      } catch (e) {
        result.error = 'Could not parse sdi-out device list: ' + e.message;
      }
      resolve(result);
    });
  });
}

/** Devices only. Rejects on failure — kept for callers that want the old shape. */
async function listDevices() {
  const r = await listDevicesDetailed();
  if (r.error && !r.devices.length) throw new Error(r.error);
  return r.devices;
}

// ---------------------------------------------------------------------------
// Output session
// ---------------------------------------------------------------------------

/**
 * One SDI playout: ffmpeg decoding to v210, piped into sdi-out, which owns the
 * clock. Seeking — and toggling Loop — is a restart (stop, then start at the
 * new position), the same way the stream decoder handles it. The stop is
 * awaited: the helper owns the card, and the next one cannot have it until
 * this one has let go (see stop()). Pause and resume go over the control
 * channel so the picture holds on the projector instead of going black.
 */
class SdiOutput {
  constructor() {
    this.helper = null;
    this.decoder = null;
    this.active = false;
    this.onStatus = null;   // (string) => void — 'playing' | 'paused' | 'underrun' | 'eof ...' | 'stopped'
    this.onError = null;    // (string) => void
    this.onEnd = null;      // () => void
    this.onLog = null;      // (string) => void — every line the helper says, and the commands run; for a log file
  }

  /**
   * @param {object} opts
   * @param {number} opts.deviceIndex   From listDevices().
   * @param {object} opts.mode          From chooseDeviceMode(): has id, width, height, fpsRational.
   * @param {string} opts.source        File, or image-sequence pattern.
   * @param {boolean} [opts.isImageSequence]
   * @param {number}  [opts.startFrame]
   * @param {number}  [opts.startTime]
   * @param {boolean} [opts.loop]
   * @param {object}  [opts.audio]      From planAudio(); the sound to embed, or null for none.
   */
  start(opts) {
    this.stop();
    const helperBin = helperPath();
    if (!helperBin) {
      if (this.onError) this.onError(MISSING_HELPER_MESSAGE);
      return false;
    }
    if (!opts || !opts.mode || !opts.mode.id) {
      if (this.onError) this.onError('SDI output needs a device mode');
      return false;
    }

    this.active = true;
    const log = (line) => { if (this.onLog) { try { this.onLog(line); } catch (_) { /* logging must never break playout */ } } };
    // MAIDENPLAYER_SDI_AUDIO=0 sends picture only — the quickest way, on a
    // rig, to tell a sound problem from a picture problem.
    const audioOff = process.env.MAIDENPLAYER_SDI_AUDIO === '0';
    const audio = (opts.audio && opts.audio.outChannels > 0 && !audioOff) ? opts.audio : null;
    if (audioOff && opts.audio) log('audio disabled by MAIDENPLAYER_SDI_AUDIO=0');

    // stdin: frames. stderr: status. fd 3: control lines. fd 4: sound.
    // 24 frames is a second of cushion at 24 fps; see sdi-out.cpp for the
    // RAM trade-off. Callers on a constrained machine can pass fewer.
    const bufferFrames = String(Math.max(4, opts.bufferFrames || 24));
    const helperArgs = ['--play', '--device', String(opts.deviceIndex), '--mode', opts.mode.id,
                        '--buffer-frames', bufferFrames];
    const helperStdio = ['pipe', 'ignore', 'pipe', 'pipe'];
    if (audio) {
      helperArgs.push('--audio-channels', String(audio.outChannels), '--audio-depth', String(audio.depth === 32 ? 32 : 16));
      helperStdio.push('pipe');
    }
    this.helper = spawn(helperBin, helperArgs, { windowsHide: true, stdio: helperStdio });
    log('helper: ' + helperBin + ' ' + helperArgs.join(' '));
    this.decoder = spawnDecoder(Object.assign({}, opts, { audio }));
    log('decoder: ' + FFMPEG + ' ' + this.decoder.spawnargs.slice(1).join(' '));

    this.decoder.stdout.pipe(this.helper.stdin);
    if (audio) this.decoder.stdio[3].pipe(this.helper.stdio[4]);

    // EPIPE is the normal outcome of a stop or seek — the helper is gone and
    // ffmpeg is still writing. Not an error.
    this.helper.stdin.on('error', (e) => { if (e && e.code !== 'EPIPE') console.error('[SDI] helper stdin:', e.message); });
    this.decoder.stdout.on('error', (e) => { if (e && e.code !== 'EPIPE') console.error('[SDI] decoder stdout:', e.message); });
    if (audio) {
      this.helper.stdio[4].on('error', (e) => { if (e && e.code !== 'EPIPE') console.error('[SDI] helper audio:', e.message); });
      this.decoder.stdio[3].on('error', (e) => { if (e && e.code !== 'EPIPE') console.error('[SDI] decoder audio:', e.message); });
    }

    let stderrTail = '';
    const thisHelper = this.helper;
    this.helper.stderr.on('data', (d) => {
      // A helper that has been stopped can still say `status:stopped` on its
      // way out, after the NEXT session has already started. That must not be
      // mistaken for the new session ending.
      if (this.helper !== thisHelper) return;
      const text = d.toString();
      for (const line of text.split('\n')) {
        if (!line) continue;
        log(line);
        if (line.startsWith('status:')) {
          const st = line.slice(7).trim();
          console.log('[SDI] ' + st);
          if (this.onStatus) this.onStatus(st);
        } else {
          console.log('[SDI] ' + line);
          stderrTail = (stderrTail + line + '\n').slice(-2000);
        }
      }
    });
    this.decoder.stderr.on('data', (d) => {
      // ffmpeg is chatty; keep only what a failure would need.
      const t = d.toString();
      if (/error|invalid|no such|permission/i.test(t)) {
        const last = t.trim().split('\n').pop();
        console.error('[SDI] ffmpeg:', last);
        log('ffmpeg: ' + last);
      }
    });

    this.helper.on('error', (e) => {
      if (!this.active) return;
      this.teardown();
      if (this.onError) this.onError('Could not run the SDI helper: ' + e.message);
    });
    // 'exit', NOT 'close'. Node's 'close' waits for every stdio pipe to shut,
    // and the control channel on fd 3 is a pipe WE hold open — so 'close'
    // never fired after a clean end and the session believed the helper was
    // still running. 'exit' fires when the process does.
    this.helper.on('exit', (code, signal) => {
      if (!this.active) return;
      const clean = code === 0;
      this.teardown();
      if (clean) { if (this.onEnd) this.onEnd(); }
      else if (this.onError) this.onError((stderrTail.trim() || 'SDI helper exited with ' + (signal || ('code ' + code))));
    });
    this.decoder.on('close', (code) => {
      // ffmpeg finishing is expected at end of clip; the helper drains and
      // then closes on its own. Anything else is reported.
      if (this.active && code !== 0 && code !== null && this.helper) {
        console.warn('[SDI] ffmpeg exited with code', code);
      }
    });

    return true;
  }

  control(cmd) {
    if (!this.helper || !this.helper.stdio[3]) return;
    if (this.onLog) { try { this.onLog('control: ' + cmd); } catch (_) { /* ignore */ } }
    try { this.helper.stdio[3].write(cmd + '\n'); } catch (_) { /* helper gone */ }
  }
  pause()  { this.control('pause'); }
  resume() { this.control('play'); }

  /**
   * Stop, and resolve once the helper has actually exited — so whoever is
   * about to start the next session (a seek, a loop toggle) knows the card
   * has been let go of. Starting the next helper while this one is still
   * dying made EnableVideoOutput fail with "another application is using
   * this device", and the badge went red.
   *
   * The helper is asked, not killed: `stop` on the control channel makes it
   * stop the schedule, disable the output and exit 0 by itself. Only if it
   * has not gone in a second is it killed. Safe to call twice, or idle.
   */
  stop() {
    const h = this.helper;
    if (!this.active && !h) return Promise.resolve();
    this.active = false;
    this.control('stop');
    this.teardown({ graceful: true });
    if (!h) return Promise.resolve();

    return new Promise((resolve) => {
      let timer = null;
      const done = () => { clearTimeout(timer); resolve(); };
      timer = setTimeout(() => {
        console.warn('[SDI] helper did not exit after stop — killing it');
        try { h.kill('SIGKILL'); } catch (_) { /* already gone */ }
        done();
      }, 1000);
      h.once('exit', done);
      if (h.exitCode !== null || h.signalCode !== null) done();   // gone before we looked
    });
  }

  /**
   * Forget both processes. The decoder is always killed — it is only ffmpeg
   * writing to a pipe. The helper is asked to leave when the stop was ours
   * (graceful), or made to when it was not — a session ending because the
   * helper died, or a caller that never awaits.
   */
  teardown(opts) {
    const graceful = !!(opts && opts.graceful);
    this.active = false;
    if (this.decoder) {
      try { this.decoder.stdout.unpipe(); } catch (_) { /* ignore */ }
      try { if (this.decoder.stdio[3]) this.decoder.stdio[3].unpipe(); } catch (_) { /* ignore */ }
      try { this.decoder.kill('SIGKILL'); } catch (_) { /* ignore */ }
      this.decoder = null;
    }
    if (this.helper) {
      const h = this.helper;
      this.helper = null;
      try { h.removeAllListeners('exit'); } catch (_) { /* ignore */ }
      // Close what we hold, or the child's pipes linger in this process.
      // stdin and the sound pipe are destroyed — whatever was queued is not
      // wanted, and the closed pipes are EOF to the helper's readers. The
      // control channel is ENDED, not destroyed, so the `stop` just written
      // actually arrives.
      try { if (h.stdin) h.stdin.destroy(); } catch (_) { /* ignore */ }
      try { if (h.stdio[4]) h.stdio[4].destroy(); } catch (_) { /* ignore */ }
      try { if (h.stdio[3]) h.stdio[3].end(); } catch (_) { /* ignore */ }
      if (!graceful) { try { h.kill('SIGTERM'); } catch (_) { /* ignore */ } }
    }
  }

  isActive() { return this.active; }
}

module.exports = {
  SdiOutput,
  chooseDeviceMode,
  pickMode,
  MISSING_HELPER_MESSAGE,
  MODES,
  RASTERS,
  RATES,
  V210_ROW_ALIGNMENT,
  v210RowBytes,
  v210FrameBytes,
  findMode,
  matchModeForSource,
  AUDIO_RATE,
  audioOutputChannels,
  planAudio,
  audioLayoutFilter,
  buildDecodeArgs,
  spawnDecoder,
  listDevices,
  listDevicesDetailed,
  isAvailable,
  helperPath,
};
