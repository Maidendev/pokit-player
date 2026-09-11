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
 *
 * v210 is the DeckLink-native pixel format (bmdFormat10BitYUV), so frames
 * reach the card with no conversion.
 *
 * WHY THE CLOCK LIVES IN A SEPARATE PROCESS
 *
 * Frame accuracy is the whole point, and Electron's main thread also runs IPC,
 * the menus, the auto-updater and garbage collection. A hard real-time
 * schedule sharing that thread drops frames. A separate process also means a
 * driver fault cannot take the player down in the middle of a screening.
 *
 * The native helper lives in native/sdi-out/ and is NOT built yet — it needs
 * Blackmagic's Desktop Video SDK, which is a separate registration-gated
 * download. Everything in this module that does not need the helper is
 * implemented and tested; device control reports plainly when it is absent.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { FFMPEG } = require('./transcoder');

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

const MODES = [
  // UHD and 4K DCI first: this is what the room runs, and both DCI widths
  // exercise the row padding above.
  { name: '4kdci2398', label: '4K DCI 4096x2160 23.98p', width: 4096, height: 2160, fps: 23.976, fpsRational: '24000/1001', deckLinkMode: 'bmdMode4kDCI2398' },
  { name: '4kdci24',   label: '4K DCI 4096x2160 24p',    width: 4096, height: 2160, fps: 24,     fpsRational: '24/1',        deckLinkMode: 'bmdMode4kDCI24' },
  { name: 'uhd2398',   label: 'UHD 3840x2160 23.98p',    width: 3840, height: 2160, fps: 23.976, fpsRational: '24000/1001', deckLinkMode: 'bmdMode4K2160p2398' },
  { name: 'uhd24',     label: 'UHD 3840x2160 24p',       width: 3840, height: 2160, fps: 24,     fpsRational: '24/1',        deckLinkMode: 'bmdMode4K2160p24' },
  { name: 'uhd25',     label: 'UHD 3840x2160 25p',       width: 3840, height: 2160, fps: 25,     fpsRational: '25/1',        deckLinkMode: 'bmdMode4K2160p25' },
  { name: '2kdci2398', label: '2K DCI 2048x1080 23.98p', width: 2048, height: 1080, fps: 23.976, fpsRational: '24000/1001', deckLinkMode: 'bmdMode2kDCI2398' },
  { name: '2kdci24',   label: '2K DCI 2048x1080 24p',    width: 2048, height: 1080, fps: 24,     fpsRational: '24/1',        deckLinkMode: 'bmdMode2kDCI24' },
  { name: 'hd1080p2398', label: 'HD 1920x1080 23.98p',   width: 1920, height: 1080, fps: 23.976, fpsRational: '24000/1001', deckLinkMode: 'bmdModeHD1080p2398' },
  { name: 'hd1080p24',   label: 'HD 1920x1080 24p',      width: 1920, height: 1080, fps: 24,     fpsRational: '24/1',        deckLinkMode: 'bmdModeHD1080p24' },
  { name: 'hd1080p25',   label: 'HD 1920x1080 25p',      width: 1920, height: 1080, fps: 25,     fpsRational: '25/1',        deckLinkMode: 'bmdModeHD1080p25' },
];

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
function matchModeForSource(source) {
  if (!source || !source.width || !source.height) return null;

  // The tolerance has to be TIGHTER than the gap between 23.976 and 24, which
  // is 0.024. A looser window treats them as the same rate, and a 24p sequence
  // sent out at 23.98 judders — one dropped frame roughly every 42 seconds,
  // which is precisely the sort of fault a screening-room check exists to
  // catch. Match only a genuinely equal rate; otherwise take the nearest, and
  // never silently blend the two.
  const RATE_EPSILON = 0.01;
  const delta = (m) => Math.abs(m.fps - source.fps);

  let pool = MODES;
  if (source.fps) {
    pool = MODES.filter((m) => delta(m) <= RATE_EPSILON);
    if (!pool.length) {
      const nearest = MODES.reduce((best, m) => (delta(m) < delta(best) ? m : best), MODES[0]);
      pool = MODES.filter((m) => Math.abs(m.fps - nearest.fps) <= RATE_EPSILON);
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
 * @param {number} [opts.startFrame]    Image sequences only — first frame number.
 * @param {number} [opts.startTime]     Everything else — seek position in seconds.
 * @returns {string[]}
 */
function buildDecodeArgs(opts) {
  const { source, mode } = opts;
  if (!source) throw new Error('buildDecodeArgs: source is required');
  if (!mode) throw new Error('buildDecodeArgs: mode is required');

  const args = [];

  if (opts.isImageSequence) {
    // The rate has to be declared: a sequence of stills carries none.
    args.push('-framerate', mode.fpsRational);
    if (opts.startFrame !== undefined) args.push('-start_number', String(opts.startFrame));
    args.push('-i', source);
  } else {
    if (opts.startTime > 0) args.push('-ss', String(opts.startTime));
    args.push('-i', source);
  }

  // Fit to the mode without cropping or stretching: scale to fit, then pad to
  // the exact raster. force_original_aspect_ratio keeps the framing intact.
  args.push(
    '-vf',
    'scale=' + mode.width + ':' + mode.height + ':force_original_aspect_ratio=decrease,' +
      'pad=' + mode.width + ':' + mode.height + ':(ow-iw)/2:(oh-ih)/2,' +
      'format=yuv422p10le',
    '-r', mode.fpsRational,
  );

  // v210 is what the card takes natively, so this is the last conversion.
  args.push('-c:v', 'v210', '-an', '-f', 'rawvideo', 'pipe:1');
  return args;
}

/** Spawn ffmpeg producing v210 frames on stdout. */
function spawnDecoder(opts) {
  const args = buildDecodeArgs(opts);
  console.log('[SDI] Decoding:', FFMPEG, args.join(' '));
  return spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
function listDevices() {
  return new Promise((resolve, reject) => {
    const helper = helperPath();
    if (!helper) {
      resolve([]);
      return;
    }

    const proc = spawn(helper, ['--list-devices'], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error('Could not run the SDI helper: ' + err.message));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || 'sdi-out exited with code ' + code));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? parsed : (parsed.devices || []));
      } catch (e) {
        reject(new Error('Could not parse sdi-out device list: ' + e.message));
      }
    });
  });
}

module.exports = {
  MISSING_HELPER_MESSAGE,
  MODES,
  V210_ROW_ALIGNMENT,
  v210RowBytes,
  v210FrameBytes,
  findMode,
  matchModeForSource,
  buildDecodeArgs,
  spawnDecoder,
  listDevices,
  isAvailable,
  helperPath,
};
