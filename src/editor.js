/**
 * MaidenPlayer — Media Editor Module
 *
 * The QuickTime 7 Pro utility layer: small media operations that used to need
 * an NLE — trim, delete a range, append and combine movies, save a still,
 * extract / remove / replace / add / mute audio — all run through the bundled
 * ffmpeg and saved as a NEW file. The source is never touched.
 *
 * LOSSLESS WHERE POSSIBLE
 *
 * Every operation that can be done by remuxing is done by remuxing (`-c copy`):
 * the compressed video and audio packets are copied into the new container
 * with no decode and no re-encode, so the result is bit-identical picture and
 * finishes at roughly disk speed. Two things decide whether that is possible:
 *
 *   1. Intra-only codecs (ProRes, DNxHD/HR, JPEG 2000, Motion JPEG, raw) can be
 *      cut on ANY frame losslessly — every frame is a keyframe.
 *   2. Long-GOP codecs (H.264, HEVC, MPEG-2) can only be cut on keyframes.
 *      A lossless cut is therefore SNAPPED to the nearest keyframe, and the
 *      caller is told by how much (see snapToKeyframes) so the user can choose
 *      a frame-accurate re-encode instead. Smart-rendering only the two edge
 *      GOPs is the true QT7 behaviour and is a future step; see PINNED.md.
 *
 * Joining files losslessly additionally needs every file to share codec,
 * geometry, pixel format, frame rate and audio layout — checkCombine() reports
 * exactly which of those differ so the UI can say why a re-encode is needed.
 *
 * Nothing in here touches Electron; it is plain Node so it can be exercised
 * from a script against real footage.
 */

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { FFMPEG, makeTempPath } = require('./transcoder');
const inspector = require('./inspector');

// ---------------------------------------------------------------------------
// Encode presets — what a re-encode produces when a lossless copy is not
// possible or not wanted. Mezzanine codecs first; H.264 for a small proxy.
// ---------------------------------------------------------------------------

const ENCODE_PRESETS = {
  prores_422hq: {
    label: 'Apple ProRes 422 HQ',
    ext: '.mov',
    video: ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'],
    evenDims: false,
  },
  prores_422: {
    label: 'Apple ProRes 422',
    ext: '.mov',
    video: ['-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'],
    evenDims: false,
  },
  prores_4444: {
    label: 'Apple ProRes 4444',
    ext: '.mov',
    // Pixel format is chosen per source so an alpha channel survives.
    video: ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0'],
    pixFmtForSource: (v) => (hasAlpha(v) ? 'yuva444p10le' : 'yuv444p10le'),
    evenDims: false,
  },
  dnxhr_hq: {
    label: 'Avid DNxHR HQ',
    ext: '.mov',
    video: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq', '-pix_fmt', 'yuv422p'],
    evenDims: true,
  },
  dnxhr_hqx: {
    label: 'Avid DNxHR HQX (10-bit)',
    ext: '.mov',
    video: ['-c:v', 'dnxhd', '-profile:v', 'dnxhr_hqx', '-pix_fmt', 'yuv422p10le'],
    evenDims: true,
  },
  h264: {
    label: 'H.264 (high quality)',
    ext: '.mp4',
    video: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p'],
    evenDims: true,
  },
};

const STILL_FORMATS = {
  png:  { label: 'PNG',  ext: '.png',  pixFmt8: 'rgb24',  pixFmt16: 'rgb48be',  alpha8: 'rgba', alpha16: 'rgba64be' },
  jpg:  { label: 'JPEG', ext: '.jpg',  pixFmt8: 'yuvj444p', pixFmt16: 'yuvj444p', extra: ['-q:v', '2'] },
  tiff: { label: 'TIFF', ext: '.tif',  pixFmt8: 'rgb24',  pixFmt16: 'rgb48le',  alpha8: 'rgba', alpha16: 'rgba64le' },
  dpx:  { label: 'DPX',  ext: '.dpx',  pixFmt8: 'rgb24',  pixFmt16: 'gbrp10le', alpha8: 'rgba', alpha16: 'rgba64le' },
  exr:  { label: 'OpenEXR', ext: '.exr', pixFmt8: 'gbrpf32le', pixFmt16: 'gbrpf32le', alpha8: 'gbrapf32le', alpha16: 'gbrapf32le' },
};

const INTRA_ONLY_CODECS = ['prores', 'dnxhd', 'vc3', 'jpeg2000', 'mjpeg', 'rawvideo', 'v210', 'ffv1', 'huffyuv', 'dpx', 'exr', 'png', 'tiff', 'cfhd', 'magicyuv', 'utvideo'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hasAlpha(videoStream) {
  const pf = (videoStream && videoStream.pixelFormat) || '';
  return /a(?:$|\d|f|p)|rgba|argb|bgra|abgr|ya\d/.test(pf) && !/^(gray|monob)/.test(pf);
}

/**
 * Escape a file path for use INSIDE an ffmpeg filter argument (lut3d=file=…).
 * Filter syntax treats ':' ',' ';' '[' ']' '\' and quotes specially, and a
 * Windows drive letter carries a colon. Forward slashes are fine on Windows.
 */
function escapeFilterPath(p) {
  return String(p)
    .replace(/\\/g, '/')
    .replace(/([\\':;,\[\]])/g, '\\$1');
}

/** A `lut3d` (or `lut1d`) filter stage for a .cube LUT, or '' when none. */
function lutFilter(lutPath) {
  if (!lutPath) return '';
  const is1D = is1DCube(lutPath);
  return (is1D ? 'lut1d' : 'lut3d') + "=file='" + escapeFilterPath(lutPath) + "':interp=" + (is1D ? 'linear' : 'tetrahedral');
}

/** Peek at a .cube header: a file with LUT_1D_SIZE and no LUT_3D_SIZE is 1D. */
function is1DCube(lutPath) {
  try {
    const fd = fs.openSync(lutPath, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const head = buf.toString('utf8', 0, n);
    return /^\s*LUT_1D_SIZE/m.test(head) && !/^\s*LUT_3D_SIZE/m.test(head);
  } catch (_) {
    return false;
  }
}

/** Common rates as exact rationals for the fps filter; anything else as-is. */
function fpsRational(fps) {
  const table = { 23.976: '24000/1001', 29.97: '30000/1001', 59.94: '60000/1001', 47.952: '48000/1001', 119.88: '120000/1001' };
  const key = Object.keys(table).find((k) => Math.abs(parseFloat(k) - fps) < 0.002);
  return key ? table[key] : String(fps);
}

function channelLayoutName(channels) {
  switch (channels) {
    case 1: return 'mono';
    case 2: return 'stereo';
    case 6: return '5.1';
    case 8: return '7.1';
    default: return channels + 'c';
  }
}

/**
 * Add `seconds` to a timecode string, producing the start timecode of a cut.
 * Drop-frame timecode (';' separator) is carried through as drop-frame using
 * the SMPTE drop rule for 29.97 / 59.94.
 */
function timecodeAdd(tc, seconds, fps) {
  const m = /^(\d{1,2})[:;](\d{2})[:;](\d{2})([:;])(\d{2})$/.exec(tc || '');
  if (!m) return null;
  const dropFrame = m[4] === ';';
  const nominal = Math.round(fps);
  const startFrames = tcToFrames(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10), parseInt(m[5], 10), nominal, dropFrame);
  const total = startFrames + Math.round(seconds * fps);
  return framesToTc(total, nominal, dropFrame);
}

function tcToFrames(hh, mm, ss, ff, nominal, dropFrame) {
  let frames = ((hh * 60 + mm) * 60 + ss) * nominal + ff;
  if (dropFrame) {
    const dropPerMinute = nominal === 60 ? 4 : 2;   // 29.97 drops 2, 59.94 drops 4
    const totalMinutes = hh * 60 + mm;
    frames -= dropPerMinute * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frames;
}

function framesToTc(frames, nominal, dropFrame) {
  let f = Math.max(0, frames);
  if (dropFrame) {
    const dropPerMinute = nominal === 60 ? 4 : 2;
    const framesPer10Min = nominal * 600 - dropPerMinute * 9;
    const framesPerMin = nominal * 60 - dropPerMinute;
    const tenMin = Math.floor(f / framesPer10Min);
    let rem = f % framesPer10Min;
    if (rem >= dropPerMinute) rem += dropPerMinute * Math.floor((rem - dropPerMinute) / framesPerMin);
    f = tenMin * framesPer10Min + rem + dropPerMinute * 9 * tenMin;
    // f is now a count in nominal-rate frames including dropped numbers.
  }
  const ff = f % nominal;
  const totalSec = Math.floor(f / nominal);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600) % 24;
  const p = (n) => String(n).padStart(2, '0');
  return p(hh) + ':' + p(mm) + ':' + p(ss) + (dropFrame ? ';' : ':') + p(ff);
}

/**
 * The ffmpeg input arguments for a source, seeking to `seek` seconds when
 * given. A source is either a file or an image sequence:
 *   { path }                                           — a movie file
 *   { isImageSequence, pattern, startFrame, fps, count } — numbered stills
 * Sequences carry no timestamps, so a seek is a start frame number.
 */
function inputArgs(source, seek) {
  const args = [];
  if (source.isImageSequence) {
    const fps = source.fps || 24;
    const first = (source.startFrame || 0) + (seek > 0 ? Math.round(seek * fps) : 0);
    args.push('-framerate', fpsRational(fps), '-start_number', String(first), '-i', source.pattern);
  } else {
    if (seek > 0) args.push('-ss', String(seek));
    args.push('-i', source.path);
  }
  return args;
}

function sourceLabel(source) {
  return source.isImageSequence ? path.basename(source.pattern) : path.basename(source.path);
}

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe runners with progress and cancellation
// ---------------------------------------------------------------------------

const activeJobs = new Map();   // jobId → { proc, output }

function parseTimeSeconds(text) {
  const m = /time=(\d+):(\d+):(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4], 10) / 100;
}

/**
 * Run one ffmpeg command. Resolves when it exits 0; rejects with the tail of
 * stderr otherwise. `duration` (seconds of output) drives progress.
 */
function runFfmpeg(args, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    console.log('[Editor] ffmpeg', args.join(' '));
    const proc = spawn(FFMPEG, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    if (opts.jobId) activeJobs.set(opts.jobId, { proc, output: opts.output });
    let tail = '';
    proc.stderr.on('data', (d) => {
      const text = d.toString();
      tail = (tail + text).slice(-4000);
      if (opts.onProgress) {
        const frameMatch = /frame=\s*(\d+)/.exec(text);
        const t = parseTimeSeconds(text);
        if (opts.totalFrames && frameMatch) {
          opts.onProgress(Math.min(0.99, parseInt(frameMatch[1], 10) / opts.totalFrames));
        } else if (opts.duration > 0 && t !== null) {
          opts.onProgress(Math.min(0.99, t / opts.duration));
        }
      }
    });
    proc.on('error', (err) => {
      if (opts.jobId) activeJobs.delete(opts.jobId);
      reject(new Error('Could not run ffmpeg: ' + err.message));
    });
    proc.on('close', (code, signal) => {
      const job = opts.jobId && activeJobs.get(opts.jobId);
      if (opts.jobId) activeJobs.delete(opts.jobId);
      if (job && job.cancelled) {
        reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
        return;
      }
      if (code === 0) {
        if (opts.onProgress) opts.onProgress(1);
        resolve(tail);
      } else {
        reject(new Error(friendlyFfmpegError(tail) + '\n\n' + tail.trim().split('\n').slice(-6).join('\n')
          + '\n(ffmpeg exit ' + (signal || code) + ')'));
      }
    });
  });
}

/** Cancel a running job and remove its partial output. */
function cancelJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return false;
  job.cancelled = true;
  try { job.proc.kill('SIGKILL'); } catch (_) { /* gone */ }
  if (job.output) setTimeout(() => { try { fs.unlinkSync(job.output); } catch (_) { /* ignore */ } }, 300);
  return true;
}

/** Turn the usual ffmpeg failure lines into one sentence a person can act on. */
function friendlyFfmpegError(tail) {
  const t = tail || '';
  if (/Could not find tag for codec/i.test(t) || /codec not currently supported in container/i.test(t)) {
    return 'This container cannot carry the source codec without re-encoding. Choose a different file type (for example .mov) or an encode preset.';
  }
  if (/Unsupported codec|not supported by the mxf muxer|mxf.*not supported/i.test(t)) {
    return 'The MXF muxer does not accept this codec as a stream copy. Save as .mov instead, or choose an encode preset.';
  }
  if (/Permission denied|EACCES/i.test(t)) return 'The destination could not be written. Check the folder permissions.';
  if (/No space left/i.test(t)) return 'The destination drive is full.';
  if (/Invalid data found|moov atom not found/i.test(t)) return 'ffmpeg could not read one of the source files.';
  if (/Filter .* has an unconnected output|Cannot find a matching stream/i.test(t)) {
    return 'The files could not be joined as-is — one of them is missing a stream the others have.';
  }
  return 'The operation failed.';
}

function runFfprobeJson(args, timeout) {
  return new Promise((resolve, reject) => {
    execFile(inspector.getFfprobePath(), args, { maxBuffer: 64 * 1024 * 1024, timeout: timeout || 60000, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) { reject(new Error((stderr || err.message).trim().split('\n').pop())); return; }
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('ffprobe returned unreadable output')); }
      });
  });
}

// ---------------------------------------------------------------------------
// Inspection helpers
// ---------------------------------------------------------------------------

/**
 * Inspect a source for editing decisions. Image sequences are described from
 * their first frame; they are never losslessly cuttable as a movie because
 * there is no movie yet.
 */
async function describeSource(source) {
  if (source.isImageSequence) {
    const fps = source.fps || 24;
    const count = source.count || 0;
    const firstFile = source.pattern.replace(/%0?\d*d/, (m) => {
      const width = parseInt(m.slice(1, -1), 10) || 0;
      return String(source.startFrame || 0).padStart(width, '0');
    });
    let video = null;
    try {
      const insp = await inspector.inspectFile(firstFile);
      video = insp.video[0] || null;
    } catch (_) { /* a still we cannot probe is still a still */ }
    return {
      source,
      duration: count / fps,
      fps,
      video: Object.assign({ isIntraOnly: true, codec: 'image-sequence' }, video || {}),
      audio: [],
      intraOnly: true,
      losslessPossible: false,   // stills → movie is always an encode
      container: null,
      startTimecode: null,
    };
  }

  const insp = await inspector.inspectFile(source.path);
  const v = insp.video[0] || null;
  const codec = (v && v.codec) || '';
  const intraOnly = !!v && (INTRA_ONLY_CODECS.includes(codec) || v.isIntraOnly);
  return {
    source,
    duration: insp.container.duration || (v && v.duration) || 0,
    fps: (v && v.frameRate) || 0,
    video: v,
    audio: insp.audio,
    intraOnly,
    losslessPossible: true,
    container: insp.container,
    startTimecode: insp.container.startTimecode || null,
    ext: path.extname(source.path).toLowerCase(),
  };
}

/**
 * Where a lossless (stream-copy) cut will actually land for a long-GOP file.
 *
 * Returns { inTime, outTime, exact, inDeltaFrames, outDeltaFrames }. For an
 * intra-only codec the points come back unchanged with exact:true. For
 * long-GOP, each point is moved to the NEAREST keyframe and the deltas say by
 * how many frames, so the UI can put the trade-off in front of the user.
 */
async function snapToKeyframes(source, inTime, outTime, desc) {
  desc = desc || await describeSource(source);
  const fps = desc.fps || 24;
  const result = { inTime, outTime, exact: true, inDeltaFrames: 0, outDeltaFrames: 0, intraOnly: desc.intraOnly };
  if (desc.intraOnly || source.isImageSequence) return result;

  const WINDOW = 20;   // seconds either side — longer than any sane GOP
  const points = [inTime, outTime].filter((t) => typeof t === 'number' && isFinite(t));
  if (!points.length) return result;
  const lo = Math.max(0, Math.min(...points) - WINDOW);
  const hi = Math.max(...points) + WINDOW;

  let keyTimes = [];
  try {
    const probe = await runFfprobeJson([
      '-hide_banner', '-loglevel', 'error',
      '-select_streams', 'v:0', '-skip_frame', 'nokey',
      '-read_intervals', lo + '%' + hi,
      '-show_entries', 'frame=pts_time,best_effort_timestamp_time',
      '-print_format', 'json', source.path,
    ]);
    keyTimes = (probe.frames || [])
      .map((f) => parseFloat(f.pts_time !== undefined ? f.pts_time : f.best_effort_timestamp_time))
      .filter((t) => isFinite(t))
      .sort((a, b) => a - b);
    // Timestamps are absolute; the player's clock starts at zero.
    const startOffset = (desc.container && desc.container.startTime) || 0;
    if (startOffset) keyTimes = keyTimes.map((t) => t - startOffset);
  } catch (err) {
    console.warn('[Editor] Keyframe probe failed:', err.message);
    return Object.assign(result, { exact: false, unknown: true });
  }
  if (!keyTimes.length) return Object.assign(result, { exact: false, unknown: true });

  const nearest = (t) => keyTimes.reduce((b, k) => (Math.abs(k - t) < Math.abs(b - t) ? k : b), keyTimes[0]);
  if (typeof inTime === 'number') {
    result.inTime = nearest(inTime);
    result.inDeltaFrames = Math.round((result.inTime - inTime) * fps);
  }
  if (typeof outTime === 'number') {
    result.outTime = nearest(outTime);
    result.outDeltaFrames = Math.round((result.outTime - outTime) * fps);
  }
  result.exact = result.inDeltaFrames === 0 && result.outDeltaFrames === 0;
  return result;
}

// ---------------------------------------------------------------------------
// Codec ↔ container rules for stream copy
// ---------------------------------------------------------------------------

const MP4_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'alac', 'mp2'];
const MOV_AUDIO = ['aac', 'mp3', 'ac3', 'eac3', 'alac', 'mp2'];
const MP4_VIDEO = ['h264', 'hevc', 'mpeg4', 'mpeg2video', 'av1', 'vp9', 'jpeg2000', 'mjpeg'];
const MOV_VIDEO = ['h264', 'hevc', 'prores', 'dnxhd', 'mpeg4', 'mpeg2video', 'jpeg2000', 'mjpeg', 'rawvideo', 'v210', 'cfhd', 'png', 'tiff', 'dpx', 'qtrle', 'vp9', 'av1'];
const MXF_VIDEO = ['dnxhd', 'mpeg2video', 'h264', 'jpeg2000', 'prores', 'rawvideo', 'dv', 'dvvideo'];

const isPcm = (c) => /^pcm_/.test(c || '');

function videoCopyOk(ext, codec) {
  if (!codec) return true;
  if (ext === '.mp4' || ext === '.m4v') return MP4_VIDEO.includes(codec);
  if (ext === '.mov') return MOV_VIDEO.includes(codec);
  if (ext === '.mxf') return MXF_VIDEO.includes(codec);
  if (ext === '.mkv') return true;
  return true;
}

/**
 * Audio output arguments for a container. Copies when the container allows
 * it (and copying is wanted); otherwise 24-bit PCM for MOV/MXF/WAV/AIFF and
 * AAC for MP4.
 */
function audioArgs(ext, srcCodec, opts) {
  opts = opts || {};
  const channels = opts.channels || 2;
  const encodeAac = ['-c:a', 'aac', '-b:a', channels > 2 ? '512k' : '320k'];
  const encodePcm = ['-c:a', 'pcm_s24le'];
  if (opts.forceEncode || !srcCodec) {
    return (ext === '.mp4' || ext === '.m4v') ? encodeAac : encodePcm;
  }
  if (ext === '.mp4' || ext === '.m4v') return MP4_AUDIO.includes(srcCodec) ? ['-c:a', 'copy'] : encodeAac;
  if (ext === '.mov') return (isPcm(srcCodec) || MOV_AUDIO.includes(srcCodec)) ? ['-c:a', 'copy'] : encodePcm;
  if (ext === '.mxf') return isPcm(srcCodec) ? ['-c:a', 'copy'] : encodePcm;
  if (ext === '.wav' || ext === '.aif' || ext === '.aiff') return isPcm(srcCodec) ? ['-c:a', 'copy'] : encodePcm;
  if (ext === '.mka' || ext === '.mkv') return ['-c:a', 'copy'];
  return ['-c:a', 'copy'];
}

function containerArgs(ext) {
  const args = [];
  if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') args.push('-movflags', '+faststart');
  return args;
}

/** `-timecode` for the muxer when the source carries one, offset to the cut. */
function timecodeArgs(desc, offsetSeconds, ext) {
  if (!desc || !desc.startTimecode) return [];
  if (!['.mov', '.mp4', '.m4v', '.mxf'].includes(ext)) return [];
  const tc = timecodeAdd(desc.startTimecode, offsetSeconds || 0, desc.fps || 24);
  return tc ? ['-timecode', tc] : [];
}

/** Video encode args for a preset, adapted to the source's pixel format. */
function presetVideoArgs(presetKey, desc, extraFilters) {
  const preset = ENCODE_PRESETS[presetKey];
  if (!preset) throw new Error('Unknown encode preset: ' + presetKey);
  const args = preset.video.slice();
  if (preset.pixFmtForSource) args.push('-pix_fmt', preset.pixFmtForSource(desc && desc.video));
  const filters = [];
  if (preset.evenDims) filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');
  if (extraFilters) filters.push(...extraFilters.filter(Boolean));
  if (filters.length) args.push('-vf', filters.join(','));
  return args;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Keep [inTime, outTime] of a source and save it as a new file.
 *
 * opts: { inTime, outTime, output, mode: 'copy'|'encode', preset, lut, jobId, onProgress }
 * In copy mode the range is first snapped to keyframes (long-GOP only), and
 * the snapped range is returned so the caller can show what was written.
 */
async function trim(source, opts) {
  const desc = await describeSource(source);
  const ext = path.extname(opts.output).toLowerCase();
  const duration = desc.duration || 0;
  let inTime = Math.max(0, opts.inTime || 0);
  let outTime = (typeof opts.outTime === 'number' && opts.outTime > inTime) ? opts.outTime : duration;
  if (duration && outTime > duration) outTime = duration;

  const mode = decideMode(opts.mode, desc, ext);
  let snapped = null;
  if (mode === 'copy') {
    snapped = await snapToKeyframes(source, inTime, outTime, desc);
    inTime = snapped.inTime;
    outTime = snapped.outTime;
  }
  const len = Math.max(1 / (desc.fps || 24), outTime - inTime);

  const args = ['-y', '-hide_banner', '-nostdin'];
  args.push(...inputArgs(source, inTime));
  if (source.isImageSequence) {
    args.push('-frames:v', String(Math.max(1, Math.round(len * (desc.fps || 24)))));
  } else {
    args.push('-t', String(len));
  }
  args.push('-map', '0:v:0');
  if (desc.audio.length) args.push('-map', '0:a');

  if (mode === 'copy') {
    args.push('-c:v', 'copy', ...audioArgs(ext, desc.audio[0] && desc.audio[0].codec, { channels: desc.audio[0] && desc.audio[0].channels }));
    args.push('-avoid_negative_ts', 'make_zero');
  } else {
    args.push(...presetVideoArgs(opts.preset || 'prores_422hq', desc, [lutFilter(opts.lut)]));
    if (desc.audio.length) args.push(...audioArgs(ext, desc.audio[0].codec, { channels: desc.audio[0].channels }));
  }
  args.push(...timecodeArgs(desc, inTime, ext), ...containerArgs(ext), opts.output);

  await runFfmpeg(args, { jobId: opts.jobId, output: opts.output, onProgress: opts.onProgress, duration: len });
  return { output: opts.output, mode, inTime, outTime, snapped, duration: len };
}

/**
 * Remove [inTime, outTime] from a source and save what remains as one file.
 * Copy mode cuts two segments losslessly and joins them with the concat
 * demuxer; encode mode does it in one filter graph.
 */
async function deleteRange(source, opts) {
  const desc = await describeSource(source);
  const ext = path.extname(opts.output).toLowerCase();
  const duration = desc.duration || 0;
  let inTime = Math.max(0, opts.inTime || 0);
  let outTime = Math.min(duration || Infinity, opts.outTime);
  if (!(outTime > inTime)) throw new Error('The Out point must be after the In point.');

  const mode = decideMode(opts.mode, desc, ext);
  let snapped = null;
  if (mode === 'copy') {
    snapped = await snapToKeyframes(source, inTime, outTime, desc);
    inTime = snapped.inTime;
    outTime = snapped.outTime;
  }
  const keepLen = inTime + Math.max(0, duration - outTime);
  const progress = opts.onProgress || (() => {});

  const segments = [];
  if (inTime > 0) segments.push({ inTime: 0, outTime: inTime });
  if (outTime < duration) segments.push({ inTime: outTime, outTime: duration });
  if (!segments.length) throw new Error('Deleting that range would leave nothing.');

  if (mode === 'copy') {
    // Segment files, then a concat list. Everything is a stream copy.
    const temps = [];
    try {
      let done = 0;
      for (const seg of segments) {
        const tmp = makeTempPath(ext);
        temps.push(tmp);
        const segLen = seg.outTime - seg.inTime;
        const args = ['-y', '-hide_banner', '-nostdin', ...inputArgs(source, seg.inTime), '-t', String(segLen),
          '-map', '0:v:0'];
        if (desc.audio.length) args.push('-map', '0:a');
        args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', tmp);
        await runFfmpeg(args, {
          jobId: opts.jobId, output: tmp, duration: segLen,
          onProgress: (p) => progress(((done + p * segLen) / keepLen) * 0.9),
        });
        done += segLen;
      }
      await concatDemux(temps, opts.output, ext, desc, { jobId: opts.jobId, onProgress: (p) => progress(0.9 + p * 0.1) });
    } finally {
      for (const t of temps) { try { fs.unlinkSync(t); } catch (_) { /* ignore */ } }
    }
  } else {
    const entries = segments.map((s) => ({ source, inTime: s.inTime, outTime: s.outTime }));
    await concatEncode([desc, desc], entries, opts.output, ext, { preset: opts.preset, lut: opts.lut, jobId: opts.jobId, onProgress: progress });
  }
  return { output: opts.output, mode, inTime, outTime, snapped, duration: keepLen };
}

/** 'copy' when asked for and possible, else 'encode'. */
function decideMode(requested, desc, ext) {
  if (requested === 'encode') return 'encode';
  if (!desc.losslessPossible) return 'encode';
  if (desc.video && !videoCopyOk(ext, desc.video.codec)) return 'encode';
  return 'copy';
}

/** Join already-compatible files with the concat demuxer, stream-copied. */
async function concatDemux(files, output, ext, desc, opts) {
  const listPath = makeTempPath('.txt');
  const lines = files.map((f) => "file '" + f.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'");
  fs.writeFileSync(listPath, lines.join('\n') + '\n');
  try {
    const args = ['-y', '-hide_banner', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-map', '0:v:0'];
    if (desc.audio && desc.audio.length) args.push('-map', '0:a');
    args.push('-c', 'copy', '-fflags', '+genpts', ...timecodeArgs(desc, 0, ext), ...containerArgs(ext), output);
    await runFfmpeg(args, { jobId: opts.jobId, output, onProgress: opts.onProgress, duration: opts.duration });
  } finally {
    try { fs.unlinkSync(listPath); } catch (_) { /* ignore */ }
  }
}

/**
 * Join entries with the concat FILTER, re-encoding to a preset. Every input
 * is conformed to the first movie's raster and rate, and to 48 kHz audio in
 * the first movie's channel layout; an entry with no audio contributes
 * silence so the join lines up.
 */
async function concatEncode(descs, entries, output, ext, opts) {
  const presetKey = opts.preset || 'prores_422hq';
  const preset = ENCODE_PRESETS[presetKey];
  if (!preset) throw new Error('Unknown encode preset: ' + presetKey);

  const first = descs[0];
  const W = first.video.width, H = first.video.height;
  const fps = first.fps || 24;
  const anyAudio = descs.some((d) => d.audio.length);
  const firstAudio = descs.find((d) => d.audio.length);
  const channels = firstAudio ? (firstAudio.audio[0].channels || 2) : 2;
  const layout = channelLayoutName(channels);

  let pixFmt = null;
  const vArgs = preset.video.slice();
  const pfIdx = vArgs.indexOf('-pix_fmt');
  if (pfIdx >= 0) { pixFmt = vArgs[pfIdx + 1]; vArgs.splice(pfIdx, 2); }
  if (preset.pixFmtForSource) pixFmt = preset.pixFmtForSource(first.video);

  const args = ['-y', '-hide_banner', '-nostdin'];
  const graph = [];
  let total = 0;
  entries.forEach((e, i) => {
    const d = descs[i];
    args.push(...inputArgs(e.source, 0));
    const inT = Math.max(0, e.inTime || 0);
    const outT = (typeof e.outTime === 'number' && e.outTime > inT) ? e.outTime : (d.duration || 0);
    const len = Math.max(0, (outT || d.duration) - inT);
    total += len;

    const vTrim = (inT > 0 || outT) ? 'trim=start=' + inT + (outT ? ':end=' + outT : '') + ',setpts=PTS-STARTPTS,' : '';
    const geom = 'scale=' + W + ':' + H + ':force_original_aspect_ratio=decrease,pad=' + W + ':' + H + ':(ow-iw)/2:(oh-ih)/2,setsar=1,';
    const even = preset.evenDims ? 'scale=trunc(iw/2)*2:trunc(ih/2)*2,' : '';
    graph.push('[' + i + ':v:0]' + vTrim + geom + even + 'fps=' + fpsRational(fps) + ',format=' + pixFmt + '[v' + i + ']');

    if (anyAudio) {
      if (d.audio.length) {
        const aTrim = (inT > 0 || outT) ? 'atrim=start=' + inT + (outT ? ':end=' + outT : '') + ',asetpts=PTS-STARTPTS,' : '';
        // All of a file's audio tracks are merged first, so a stereo pair
        // delivered as two monos still comes through as two channels.
        const merge = d.audio.length > 1
          ? d.audio.map((_, k) => '[' + i + ':a:' + k + ']').join('') + 'amerge=inputs=' + d.audio.length + ','
          : '[' + i + ':a:0]';
        graph.push(merge + aTrim + 'aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=' + layout + '[a' + i + ']');
      } else {
        graph.push('anullsrc=r=48000:cl=' + layout + ',atrim=duration=' + len.toFixed(3) + '[a' + i + ']');
      }
    }
  });

  const tails = entries.map((_, i) => '[v' + i + ']' + (anyAudio ? '[a' + i + ']' : '')).join('');
  let concat = tails + 'concat=n=' + entries.length + ':v=1:a=' + (anyAudio ? 1 : 0);
  const lut = lutFilter(opts.lut);
  concat += anyAudio ? '[vcat][acat]' : '[vcat]';
  graph.push(concat);
  if (lut) graph.push('[vcat]' + lut + '[vout]');
  const vOut = lut ? '[vout]' : '[vcat]';

  args.push('-filter_complex', graph.join(';'), '-map', vOut);
  if (anyAudio) args.push('-map', '[acat]');
  args.push(...vArgs);
  if (anyAudio) args.push(...audioArgs(ext, null, { forceEncode: true, channels }));
  args.push(...timecodeArgs(first, entries[0].inTime || 0, ext), ...containerArgs(ext), output);

  await runFfmpeg(args, { jobId: opts.jobId, output, onProgress: opts.onProgress, duration: total });
  return { duration: total };
}

/**
 * Can these entries be joined by stream copy? Every file must agree on the
 * things a decoder cannot switch mid-stream. Returns the per-entry
 * descriptions too, so the UI can show them without probing twice.
 */
async function checkCombine(entries) {
  const descs = [];
  for (const e of entries) descs.push(await describeSource(e.source));
  const reasons = [];
  const first = descs[0];
  if (!first || !first.video) return { lossless: false, reasons: ['No video in the first movie'], descs };

  descs.forEach((d, i) => {
    const name = sourceLabel(entries[i].source);
    if (!d.losslessPossible) { reasons.push(name + ': image sequence (must be encoded)'); return; }
    if (!d.video) { reasons.push(name + ': no video stream'); return; }
    if (i === 0) return;
    const f = first.video, v = d.video;
    if (f.codec !== v.codec) reasons.push(name + ': video codec ' + (v.codecFriendly || v.codec) + ' ≠ ' + (f.codecFriendly || f.codec));
    if (f.width !== v.width || f.height !== v.height) reasons.push(name + ': ' + v.width + '×' + v.height + ' ≠ ' + f.width + '×' + f.height);
    if (f.pixelFormat !== v.pixelFormat) reasons.push(name + ': pixel format ' + v.pixelFormat + ' ≠ ' + f.pixelFormat);
    if (Math.abs((f.frameRate || 0) - (v.frameRate || 0)) > 0.001) reasons.push(name + ': ' + v.frameRate + ' fps ≠ ' + f.frameRate + ' fps');
    if (first.audio.length !== d.audio.length) reasons.push(name + ': ' + d.audio.length + ' audio track(s) ≠ ' + first.audio.length);
    else {
      d.audio.forEach((a, k) => {
        const b = first.audio[k];
        if (a.codec !== b.codec) reasons.push(name + ': audio codec ' + a.codec + ' ≠ ' + b.codec);
        if (a.sampleRate !== b.sampleRate) reasons.push(name + ': ' + a.sampleRate + ' Hz ≠ ' + b.sampleRate + ' Hz');
        if (a.channels !== b.channels) reasons.push(name + ': ' + a.channels + ' ch ≠ ' + b.channels + ' ch');
      });
    }
  });
  // Ranges on a long-GOP source snap to keyframes in copy mode: not a blocker,
  // but worth saying.
  const notes = [];
  descs.forEach((d, i) => {
    const e = entries[i];
    if (d.losslessPossible && !d.intraOnly && (e.inTime > 0 || typeof e.outTime === 'number')) {
      notes.push(sourceLabel(e.source) + ': long-GOP — a lossless cut snaps to keyframes');
    }
  });
  return { lossless: reasons.length === 0, reasons, notes, descs, intraOnly: descs.every((d) => d.intraOnly) };
}

/**
 * Append / combine: entries [{ source, inTime?, outTime? }] → one movie.
 * opts: { output, mode, preset, lut, jobId, onProgress }
 */
async function combine(entries, opts) {
  if (!entries || entries.length < 1) throw new Error('Nothing to combine.');
  const ext = path.extname(opts.output).toLowerCase();
  const check = await checkCombine(entries);
  const descs = check.descs;
  let mode = opts.mode === 'encode' ? 'encode' : (check.lossless ? 'copy' : 'encode');
  if (mode === 'copy' && !videoCopyOk(ext, descs[0].video.codec)) mode = 'encode';
  const progress = opts.onProgress || (() => {});

  if (mode === 'copy') {
    const temps = [];
    const files = [];
    const snaps = [];
    try {
      const lens = entries.map((e, i) => {
        const d = descs[i];
        const inT = e.inTime || 0;
        const outT = (typeof e.outTime === 'number') ? e.outTime : d.duration;
        return Math.max(0, outT - inT);
      });
      const total = lens.reduce((a, b) => a + b, 0) || 1;
      let done = 0;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const d = descs[i];
        const whole = !(e.inTime > 0) && (typeof e.outTime !== 'number' || e.outTime >= d.duration - 0.001);
        if (whole) { files.push(e.source.path); done += lens[i]; continue; }
        const snap = await snapToKeyframes(e.source, e.inTime || 0, typeof e.outTime === 'number' ? e.outTime : d.duration, d);
        snaps.push(snap);
        const tmp = makeTempPath(path.extname(e.source.path).toLowerCase() || ext);
        temps.push(tmp);
        const segLen = snap.outTime - snap.inTime;
        const args = ['-y', '-hide_banner', '-nostdin', ...inputArgs(e.source, snap.inTime), '-t', String(segLen), '-map', '0:v:0'];
        if (d.audio.length) args.push('-map', '0:a');
        args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', tmp);
        await runFfmpeg(args, { jobId: opts.jobId, output: tmp, duration: segLen, onProgress: (p) => progress(((done + p * segLen) / total) * 0.85) });
        files.push(tmp);
        done += segLen;
      }
      await concatDemux(files, opts.output, ext, descs[0], { jobId: opts.jobId, onProgress: (p) => progress(0.85 + p * 0.15), duration: total });
    } finally {
      for (const t of temps) { try { fs.unlinkSync(t); } catch (_) { /* ignore */ } }
    }
    return { output: opts.output, mode, snapped: snaps, check };
  }

  await concatEncode(descs, entries, opts.output, ext, { preset: opts.preset, lut: opts.lut, jobId: opts.jobId, onProgress: progress });
  return { output: opts.output, mode, check };
}

/**
 * Save one frame as a still.
 * opts: { time, output, format: 'png'|'jpg'|'tiff'|'dpx'|'exr', lut, deep }
 * Bit depth follows the source: a 10-bit or float source is written as 16-bit
 * (or 10-bit DPX, float EXR) unless `deep` is false.
 */
async function saveFrame(source, opts) {
  const desc = await describeSource(source);
  const fmt = STILL_FORMATS[opts.format] || STILL_FORMATS.png;
  const fps = desc.fps || source.fps || 24;
  const frameIdx = Math.max(0, Math.round((opts.time || 0) * fps));
  const bitDepth = (desc.video && desc.video.bitDepth) || 8;
  const deep = opts.deep !== false && bitDepth > 8;
  const alpha = hasAlpha(desc.video);
  let pixFmt = deep ? fmt.pixFmt16 : fmt.pixFmt8;
  if (alpha && fmt.alpha8) pixFmt = deep ? fmt.alpha16 : fmt.alpha8;

  const args = ['-y', '-hide_banner', '-nostdin'];
  if (source.isImageSequence) {
    args.push(...inputArgs(source, frameIdx / fps));
  } else {
    // Land just inside the frame: with accurate seeking ffmpeg emits the first
    // frame whose timestamp is >= -ss, so aim a hair before the frame start.
    args.push('-ss', String(Math.max(0, frameIdx / fps - 0.0005)), '-i', source.path);
  }
  args.push('-map', '0:v:0', '-frames:v', '1');
  const filters = [lutFilter(opts.lut)].filter(Boolean);
  if (filters.length) args.push('-vf', filters.join(','));
  args.push('-pix_fmt', pixFmt);
  if (fmt.extra) args.push(...fmt.extra);
  if (opts.format === 'exr') args.push('-compression', 'zip16', '-format', 'half');
  args.push('-update', '1', opts.output);
  await runFfmpeg(args, { jobId: opts.jobId, output: opts.output });
  return { output: opts.output, frameIdx, pixFmt };
}

/**
 * Audio out of a movie, into its own file.
 * opts: { output, format: 'wav'|'aiff'|'copy' }
 * WAV/AIFF hold one stream, so several tracks are merged into one
 * multichannel file; 'copy' keeps every track as-is in a MOV.
 */
async function extractAudio(source, opts) {
  const desc = await describeSource(source);
  if (!desc.audio.length) throw new Error('This movie has no audio.');
  const ext = path.extname(opts.output).toLowerCase();
  const args = ['-y', '-hide_banner', '-nostdin', '-i', source.path, '-vn', '-dn', '-sn'];
  if (opts.format === 'copy') {
    args.push('-map', '0:a', '-c:a', 'copy');
  } else {
    if (desc.audio.length > 1) {
      const inputs = desc.audio.map((_, k) => '[0:a:' + k + ']').join('');
      args.push('-filter_complex', inputs + 'amerge=inputs=' + desc.audio.length + '[a]', '-map', '[a]');
    } else {
      args.push('-map', '0:a:0');
    }
    args.push('-c:a', opts.format === 'aiff' ? 'pcm_s24be' : 'pcm_s24le');
  }
  args.push(opts.output);
  await runFfmpeg(args, { jobId: opts.jobId, output: opts.output, onProgress: opts.onProgress, duration: desc.duration });
  return { output: opts.output, ext };
}

/** The picture without its audio — a stream copy. */
async function removeAudio(source, opts) {
  const desc = await describeSource(source);
  const ext = path.extname(opts.output).toLowerCase();
  const args = ['-y', '-hide_banner', '-nostdin', '-i', source.path, '-map', '0:v:0', '-c:v', 'copy', '-an',
    ...timecodeArgs(desc, 0, ext), ...containerArgs(ext), opts.output];
  await runFfmpeg(args, { jobId: opts.jobId, output: opts.output, onProgress: opts.onProgress, duration: desc.duration });
  return { output: opts.output };
}

/**
 * Swap the movie's audio for another file's (replace) or add it alongside
 * (add). Video is copied; the new audio is copied when the container allows
 * and otherwise encoded to PCM/AAC. `-shortest` keeps the result the length
 * of the picture.
 * opts: { audioPath, output, add: boolean, offset: seconds (audio delay, may be negative) }
 */
async function replaceAudio(source, opts) {
  const desc = await describeSource(source);
  const ext = path.extname(opts.output).toLowerCase();
  let aDesc;
  try { aDesc = await inspector.inspectFile(opts.audioPath); } catch (e) { throw new Error('Could not read the audio file: ' + e.message); }
  if (!aDesc.audio.length) throw new Error('The chosen file has no audio.');

  const args = ['-y', '-hide_banner', '-nostdin', '-i', source.path];
  if (opts.offset) args.push('-itsoffset', String(opts.offset));
  args.push('-i', opts.audioPath, '-map', '0:v:0');
  if (opts.add && desc.audio.length) args.push('-map', '0:a');
  args.push('-map', '1:a', '-c:v', 'copy');
  // Existing tracks stay as they are; only the incoming file is checked
  // against the container. Both are set per stream so one rule cannot
  // re-encode the other.
  const existingCount = opts.add ? desc.audio.length : 0;
  for (let k = 0; k < existingCount; k++) {
    const a = audioArgs(ext, desc.audio[k].codec, { channels: desc.audio[k].channels });
    args.push('-c:a:' + k, a[1]);
    if (a[2] === '-b:a') args.push('-b:a:' + k, a[3]);
  }
  aDesc.audio.forEach((a, j) => {
    const idx = existingCount + j;
    const enc = audioArgs(ext, a.codec, { channels: a.channels });
    args.push('-c:a:' + idx, enc[1]);
    if (enc[2] === '-b:a') args.push('-b:a:' + idx, enc[3]);
  });
  args.push('-shortest', ...timecodeArgs(desc, 0, ext), ...containerArgs(ext), opts.output);
  await runFfmpeg(args, { jobId: opts.jobId, output: opts.output, onProgress: opts.onProgress, duration: desc.duration });
  return { output: opts.output };
}

/**
 * Silence chosen channels. Video is copied; only tracks with a muted channel
 * are re-encoded (24-bit PCM in MOV/MXF, AAC in MP4), the rest are copied.
 * opts: { mutes: [{ track: 0-based audio stream index, channels: [0-based] | 'all' }], output }
 */
async function muteChannels(source, opts) {
  const desc = await describeSource(source);
  if (!desc.audio.length) throw new Error('This movie has no audio.');
  const ext = path.extname(opts.output).toLowerCase();
  const args = ['-y', '-hide_banner', '-nostdin', '-i', source.path, '-map', '0:v:0', '-map', '0:a', '-c:v', 'copy'];
  const byTrack = new Map();
  for (const m of opts.mutes || []) byTrack.set(m.track, m.channels);

  desc.audio.forEach((a, k) => {
    const muted = byTrack.get(k);
    if (!muted || (Array.isArray(muted) && !muted.length)) {
      const enc = audioArgs(ext, a.codec, { channels: a.channels });
      args.push('-c:a:' + k, enc[1]);
      if (enc[2] === '-b:a') args.push('-b:a:' + k, enc[3]);
      return;
    }
    const n = a.channels || 2;
    let filter;
    if (muted === 'all' || muted.length >= n) {
      filter = 'volume=0';
    } else {
      const outs = [];
      for (let c = 0; c < n; c++) outs.push('c' + c + '=' + (muted.includes(c) ? '0*c' + c : 'c' + c));
      filter = 'pan=' + channelLayoutName(n) + '|' + outs.join('|');
    }
    args.push('-filter:a:' + k, filter);
    const enc = audioArgs(ext, a.codec, { forceEncode: true, channels: n });
    args.push('-c:a:' + k, enc[1]);
    if (enc[2] === '-b:a') args.push('-b:a:' + k, enc[3]);
  });
  args.push(...timecodeArgs(desc, 0, ext), ...containerArgs(ext), opts.output);
  await runFfmpeg(args, { jobId: opts.jobId, output: opts.output, onProgress: opts.onProgress, duration: desc.duration });
  return { output: opts.output };
}

// ---------------------------------------------------------------------------
// Dispatch — one entry point for the IPC layer
// ---------------------------------------------------------------------------

const OPERATIONS = { trim, deleteRange, combine, saveFrame, extractAudio, removeAudio, replaceAudio, muteChannels };

/**
 * Run a named operation. `payload.source` (or `payload.entries` for combine)
 * plus the operation's own options. Progress arrives via onProgress(0..1).
 */
async function run(op, payload, onProgress) {
  const fn = OPERATIONS[op];
  if (!fn) throw new Error('Unknown edit operation: ' + op);
  const opts = Object.assign({}, payload, { onProgress });
  if (op === 'combine') return fn(payload.entries, opts);
  if (!payload.source) throw new Error('No source given for ' + op);
  return fn(payload.source, opts);
}

module.exports = {
  run,
  cancelJob,
  trim,
  deleteRange,
  combine,
  checkCombine,
  saveFrame,
  extractAudio,
  removeAudio,
  replaceAudio,
  muteChannels,
  describeSource,
  snapToKeyframes,
  ENCODE_PRESETS,
  STILL_FORMATS,
  escapeFilterPath,
  lutFilter,
  timecodeAdd,
  fpsRational,
  _internal: { inputArgs, audioArgs, videoCopyOk, decideMode, hasAlpha, framesToTc, tcToFrames },
};
