/**
 * MaidenPlayer — Blackmagic RAW Module
 *
 * .braw is the one professional format the bundled FFmpeg cannot touch.
 * Blackmagic never contributed their decoder to FFmpeg and have said they do
 * not intend to, so there is no demuxer, no decoder, and `ffmpeg -i` fails on
 * a .braw file before it reads a single frame. Everything in transcoder.js
 * and stream-decoder.js assumes FFmpeg can at least open the input, so .braw
 * needs its own probe and its own frame source.
 *
 * Decoding goes through a small native helper, `braw-decode`, built from the
 * Blackmagic RAW SDK (see native/braw-decode/). The helper does the one thing
 * FFmpeg cannot — turn .braw into raw frames — and then the existing pipeline
 * takes over unchanged:
 *
 *   .braw → braw-decode (SDK, GPU) → rawvideo on stdout
 *         → ffmpeg (H.264 → fMP4) → IPC → MSE → <video>
 *
 * That reuses the whole streaming path rather than duplicating it, so seeking,
 * backpressure and audio behave the same as they do for ProRes.
 *
 * The helper defines this CLI contract, which both sides depend on:
 *
 *   braw-decode --info <file>
 *       Prints one JSON object describing the clip and exits 0.
 *
 *   braw-decode --frames <file> [--start-frame N] [--audio-out <file.wav>]
 *       Writes raw frames to stdout in the pixel format reported by --info,
 *       optionally writing the clip's audio to a WAV file first.
 *
 * If the helper is missing the player must say so plainly rather than failing
 * with an FFmpeg parse error, hence MISSING_DECODER_MESSAGE.
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const BRAW_EXTENSIONS = ['.braw'];

/** Frames come out of the SDK as 16-bit RGBA unless --info says otherwise. */
const DEFAULT_PIXEL_FORMAT = 'rgba64le';

const MISSING_DECODER_MESSAGE =
  'Blackmagic RAW support is not installed in this build.\n\n' +
  '.braw files need the Blackmagic RAW decoder, which is separate from ' +
  'FFmpeg — FFmpeg cannot read .braw at all.\n\n' +
  'Every other format in MaidenPlayer still works.';

// ---------------------------------------------------------------------------
// Locating the helper
//
// Mirrors getFfmpegPath() in transcoder.js: bundled binary first, unpacked
// from the asar, then extraResources, then a PATH lookup. The env override
// exists so the helper can be tested before it is bundled.
// ---------------------------------------------------------------------------
function getDecoderPath() {
  const override = process.env.MAIDENPLAYER_BRAW_DECODE;
  if (override) {
    console.log('[Braw] Using decoder from MAIDENPLAYER_BRAW_DECODE:', override);
    return override;
  }

  const exe = process.platform === 'win32' ? 'braw-decode.exe' : 'braw-decode';

  const binDir = path.join(__dirname, 'bin');
  // asarUnpack puts src/bin/** beside the archive rather than inside it.
  const binDirUnpacked = binDir.includes('app.asar')
    ? binDir.replace('app.asar', 'app.asar.unpacked')
    : binDir;

  const candidates = [
    path.join(binDirUnpacked, exe),
    path.join(binDir, exe),
  ];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', exe));
  }

  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) {
        console.log('[Braw] ✓ Found decoder at:', fp);
        return fp;
      }
    } catch (_) { /* ignore */ }
    console.log('[Braw] Checking decoder candidate:', fp);
  }

  console.log('[Braw] No braw-decode helper found — .braw playback unavailable');
  return null;
}

let cachedDecoder;
let decoderResolved = false;

function decoderPath() {
  if (!decoderResolved) {
    cachedDecoder = getDecoderPath();
    decoderResolved = true;
  }
  return cachedDecoder;
}

/** True when this build can actually decode .braw. */
function isAvailable() {
  return decoderPath() !== null;
}

function isBrawFile(filePath) {
  return BRAW_EXTENSIONS.includes(path.extname(filePath || '').toLowerCase());
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/**
 * Probe a .braw clip.
 *
 * Returns the same shape as transcoder.probeFile() so the renderer and the
 * inspector need no special case — plus isBraw and the raw-frame details the
 * stream decoder needs to build its FFmpeg input arguments.
 *
 * @param {string} filePath
 * @returns {Promise<object>}
 */
function probe(filePath) {
  return new Promise((resolve, reject) => {
    const decoder = decoderPath();
    if (!decoder) {
      reject(new Error(MISSING_DECODER_MESSAGE));
      return;
    }

    console.log('[Braw] Probing:', filePath);
    const proc = spawn(decoder, ['--info', filePath], { windowsHide: true });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error('Could not run the Blackmagic RAW decoder: ' + err.message));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || ('braw-decode exited with code ' + code);
        console.error('[Braw] Probe failed:', detail);
        reject(new Error(detail));
        return;
      }

      let raw;
      try {
        raw = JSON.parse(stdout);
      } catch (e) {
        reject(new Error('Could not parse braw-decode output: ' + e.message));
        return;
      }

      resolve(shapeProbe(filePath, raw));
    });
  });
}

/**
 * Map the helper's JSON onto the probe object the rest of the app expects.
 * Kept separate from probe() so it can be unit-tested without the binary.
 */
function shapeProbe(filePath, raw) {
  const fps = Number(raw.frameRate) || 0;
  const frameCount = Number(raw.frameCount) || 0;

  const info = {
    filePath,
    codec: 'braw',
    codecFriendly: raw.codecFriendly || 'Blackmagic RAW',
    codecProfile: raw.compressionRatio || null,
    container: 'braw',
    width: Number(raw.width) || 0,
    height: Number(raw.height) || 0,
    fps,
    // A .braw carries a frame count, not a duration, so derive it. Without
    // this the transport has no scrub range.
    duration: fps > 0 ? frameCount / fps : 0,
    bitrate: null,
    audioCodec: raw.hasAudio ? 'pcm' : null,
    audioFriendly: raw.hasAudio ? 'PCM (Blackmagic RAW)' : null,
    audioDetails: null,
    audioStreamCount: raw.hasAudio ? 1 : 0,
    audioChannelsTotal: raw.hasAudio ? (Number(raw.audioChannels) || 2) : 0,
    // Chromium cannot play .braw natively, so it always takes the stream path.
    needsTranscode: true,
    isProRes: false,
    isDNx: false,
    isBraw: true,
    sourceTimecode: raw.timecode || null,
    sourceTimecodeSeconds: 0,

    // Raw-frame details — consumed by stream-decoder.js to describe the pipe
    // to FFmpeg, which cannot infer any of it from headerless rawvideo.
    brawFrameCount: frameCount,
    brawPixelFormat: raw.pixelFormat || DEFAULT_PIXEL_FORMAT,
    // Exact rational rate ("24000/1001") keeps 23.976 from drifting when it
    // is rounded into a decimal.
    brawFrameRateRational: raw.frameRateRational || String(fps),
    brawColorScience: raw.colorScience || null,
    brawIso: raw.iso || null,
    brawWhiteBalance: raw.whiteBalance || null,
  };

  if (info.sourceTimecode && fps > 0) {
    info.sourceTimecodeSeconds = timecodeToSeconds(info.sourceTimecode, fps);
  }

  return info;
}

/** "01:00:00:00" → seconds. Mirrors parseTimecodeToSeconds in transcoder.js. */
function timecodeToSeconds(tc, fps) {
  const m = String(tc).match(/^(\d+):(\d+):(\d+)[:;](\d+)$/);
  if (!m || !fps) return 0;
  return (
    parseInt(m[1], 10) * 3600 +
    parseInt(m[2], 10) * 60 +
    parseInt(m[3], 10) +
    parseInt(m[4], 10) / fps
  );
}

// ---------------------------------------------------------------------------
// Frame source
// ---------------------------------------------------------------------------

/**
 * Spawn the decoder so it writes raw frames to stdout.
 *
 * @param {string} filePath
 * @param {object} opts
 * @param {number} [opts.startFrame=0] Frame to start decoding from.
 * @param {string} [opts.audioOut]     Write the clip's audio to this WAV path.
 * @returns {ChildProcess}
 */
function spawnFrames(filePath, opts = {}) {
  const decoder = decoderPath();
  if (!decoder) throw new Error(MISSING_DECODER_MESSAGE);

  const args = ['--frames', filePath];
  if (opts.startFrame > 0) args.push('--start-frame', String(Math.floor(opts.startFrame)));
  if (opts.audioOut) args.push('--audio-out', opts.audioOut);

  console.log('[Braw] Decoding:', decoder, args.join(' '));
  return spawn(decoder, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------------------
// Deep inspection ("Check It" panel)
// ---------------------------------------------------------------------------

/**
 * Build the inspector's report for a .braw clip.
 *
 * inspector.js is entirely ffprobe-driven and ffprobe has no .braw demuxer, so
 * this fills in the same object shape from the decoder's metadata instead. The
 * fields the format genuinely does not carry are left null rather than guessed
 * at — a QC panel that invents a colour matrix is worse than one that admits
 * it does not know.
 *
 * @param {string} filePath
 * @returns {Promise<object>} Same shape as inspector.inspectFile().
 */
async function inspect(filePath) {
  const info = await probe(filePath);

  let size = null;
  try {
    size = fs.statSync(filePath).size;
  } catch (_) { /* unreadable size is not fatal */ }

  const video = [{
    index: 0,
    codec: 'braw',
    codecFriendly: info.codecFriendly,
    profile: info.codecProfile,          // the compression ratio, e.g. "8:1"
    level: null,
    codecTag: null,
    codedWidth: info.width,
    codedHeight: info.height,
    displayAspectRatio: aspectRatio(info.width, info.height),
    pixelAspectRatio: '1:1',
    cleanAperture: null,
    frameRate: info.fps,
    avgFrameRate: info.fps,
    // Blackmagic RAW is a single-image-per-frame format: no field order, no
    // inter-frame prediction.
    scanType: 'Progressive',
    fieldOrder: null,
    pixelFormat: info.brawPixelFormat,
    chromaSubsampling: 'RAW (CFA)',
    bitDepth: 12,
    colorPrimaries: null,
    colorTransfer: null,
    colorMatrix: null,
    colorRange: null,
    hdrFormat: null,
    hdrMetadata: null,
    bitrate: size && info.duration ? Math.round((size * 8) / info.duration) : null,
    nbFrames: info.brawFrameCount,
    duration: info.duration,
    hasBFrames: false,
    isIntraOnly: true,
    tags: {},
  }];

  const audio = info.audioCodec ? [{
    index: 1,
    codec: 'pcm',
    codecFriendly: info.audioFriendly,
    profile: null,
    channels: info.audioChannelsTotal,
    channelLayout: info.audioChannelsTotal === 2 ? 'stereo' : null,
    speakerLabels: null,
    sampleRate: null,
    bitDepth: null,
    sampleFormat: null,
    bitrate: null,
    duration: info.duration,
    language: null,
    title: null,
    tags: {},
  }] : [];

  return {
    filePath,
    container: {
      formatName: 'braw',
      formatLongName: 'Blackmagic RAW',
      duration: info.duration,
      size,
      bitrate: video[0].bitrate,
      startTime: 0,
      nbStreams: video.length + audio.length,
      startTimecode: info.sourceTimecode,
      reelName: null,
      tags: {},
    },
    video,
    audio,
    subtitle: [],
    data: [],
    chapters: [],
    programs: [],
    // Camera metadata has no ffprobe equivalent, so it rides in its own
    // section rather than being forced into a container tag.
    braw: {
      colorScience: info.brawColorScience,
      iso: info.brawIso,
      whiteBalance: info.brawWhiteBalance,
      frameRateRational: info.brawFrameRateRational,
    },
  };
}

/** Reduce WxH to a display aspect ratio like "16:9". */
function aspectRatio(w, h) {
  if (!w || !h) return null;
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const d = gcd(w, h);
  return (w / d) + ':' + (h / d);
}

module.exports = {
  BRAW_EXTENSIONS,
  DEFAULT_PIXEL_FORMAT,
  MISSING_DECODER_MESSAGE,
  isAvailable,
  isBrawFile,
  probe,
  shapeProbe,
  inspect,
  spawnFrames,
  decoderPath,
};
