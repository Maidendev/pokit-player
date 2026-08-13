/**
 * PokitPlayer — Transcoder Module v1.1.3
 *
 * Uses bundled ffmpeg to:
 *  1. Probe files for codec info (ProRes, DNxHD/DNxHR, etc.)
 *  2. Transcode non-native codecs to H.264 MP4 for HTML5 playback
 *  3. Build playable video from image sequences (DPX, EXR, TIFF, PNG, JPG)
 *
 * Temporary files are placed in the OS temp directory and cleaned on exit.
 *
 * IMPORTANT: ffmpeg-static npm only installs the binary for the BUILD platform.
 * We bundle platform-specific binaries in src/bin/ for cross-platform support:
 *   - src/bin/ffmpeg.exe     (Windows x64)
 *   - src/bin/ffmpeg-darwin  (macOS x64)
 *   - node_modules/ffmpeg-static/ffmpeg (Linux x64, from npm)
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

// ---------------------------------------------------------------------------
// ffmpeg path – works both in dev and in an asar-packed Electron build
// Handles cross-platform: Linux, Windows, macOS
// ---------------------------------------------------------------------------
function getFfmpegPath() {
  const platform = process.platform; // 'win32', 'darwin', 'linux'
  console.log('[Transcoder] Platform:', platform);

  // --- Strategy ---
  // 1. Check for our bundled platform-specific binary in src/bin/ (or extraResources)
  // 2. Fall back to ffmpeg-static npm package (only works for build platform)
  // 3. Fall back to system PATH ffmpeg

  let candidates = [];

  // Bundled binary paths (both in dev and in packed builds)
  const srcDir = __dirname; // src/
  const binDir = path.join(srcDir, 'bin');
  // In ASAR-packed builds, asarUnpack extracts to app.asar.unpacked/
  const binDirUnpacked = binDir.includes('app.asar')
    ? binDir.replace('app.asar', 'app.asar.unpacked')
    : binDir;

  if (platform === 'win32') {
    candidates.push(path.join(binDirUnpacked, 'ffmpeg.exe'));
    candidates.push(path.join(binDir, 'ffmpeg.exe'));
    // extraResources path
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'bin', 'ffmpeg.exe'));
    }
  } else if (platform === 'darwin') {
    // Check arch-specific binary first (arm64 vs x64)
    const arch = process.arch; // 'arm64' or 'x64'
    const archBinaryName = 'ffmpeg-darwin-' + arch;
    candidates.push(path.join(binDirUnpacked, archBinaryName));
    candidates.push(path.join(binDir, archBinaryName));
    // Then generic darwin binary
    candidates.push(path.join(binDirUnpacked, 'ffmpeg-darwin'));
    candidates.push(path.join(binDir, 'ffmpeg-darwin'));
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'bin', archBinaryName));
      candidates.push(path.join(process.resourcesPath, 'bin', 'ffmpeg-darwin'));
    }
  } else {
    // Linux - also check our bin dir
    candidates.push(path.join(binDirUnpacked, 'ffmpeg'));
    candidates.push(path.join(binDir, 'ffmpeg'));
  }

  // ffmpeg-static npm path (works for the platform the app was built on)
  try {
    let npmPath = require('ffmpeg-static');
    if (npmPath) {
      // Handle asar packing
      if (npmPath.includes('app.asar')) {
        npmPath = npmPath.replace('app.asar', 'app.asar.unpacked');
      }
      candidates.push(npmPath);
    }
  } catch (_) { /* not installed */ }

  // System PATH fallback
  candidates.push(platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

  // Find the first candidate that exists
  for (const fp of candidates) {
    console.log('[Transcoder] Checking ffmpeg candidate:', fp);
    // For PATH-only entries (no directory separator), skip fs.existsSync
    if (!path.isAbsolute(fp) && !fp.includes(path.sep)) {
      console.log('[Transcoder] Using system PATH fallback:', fp);
      return fp;
    }
    try {
      if (fs.existsSync(fp)) {
        console.log('[Transcoder] ✓ Found ffmpeg at:', fp);
        return fp;
      }
    } catch (_) { /* ignore */ }
  }

  // Ultimate fallback
  const fallback = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  console.log('[Transcoder] No bundled ffmpeg found, falling back to:', fallback);
  return fallback;
}

const FFMPEG = getFfmpegPath();

// ---------------------------------------------------------------------------
// Temp file management
// ---------------------------------------------------------------------------
const tempFiles = new Set();

function makeTempPath(suffix = '.mp4') {
  const name = 'pokitplayer_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + suffix;
  const p = path.join(os.tmpdir(), name);
  tempFiles.add(p);
  return p;
}

function cleanupTempFiles() {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
  }
  tempFiles.clear();
}

// ---------------------------------------------------------------------------
// Human-readable codec names
// ---------------------------------------------------------------------------
const CODEC_FRIENDLY_NAMES = {
  'h264': 'H.264',
  'avc1': 'H.264',
  'hevc': 'H.265 / HEVC',
  'h265': 'H.265 / HEVC',
  'vp8': 'VP8',
  'vp9': 'VP9',
  'av1': 'AV1',
  'theora': 'Theora',
  'prores': 'Apple ProRes',
  'dnxhd': 'DNxHD',
  'dnxhr': 'DNxHR',
  'vc3': 'DNxHD',
  'mpeg2video': 'MPEG-2',
  'mpeg4': 'MPEG-4',
  'mjpeg': 'Motion JPEG',
  'rawvideo': 'Raw Video',
  'ffv1': 'FFV1',
  'huffyuv': 'HuffYUV',
  'wmv3': 'WMV3',
  'wmv2': 'WMV2',
  'wmv1': 'WMV',
  'flv1': 'Flash Video',
  'msmpeg4v3': 'MS-MPEG4',
  'cinepak': 'Cinepak',
  'indeo5': 'Indeo 5',
  // Audio codecs
  'aac': 'AAC',
  'mp3': 'MP3',
  'pcm_s16le': 'PCM 16-bit LE',
  'pcm_s16be': 'PCM 16-bit BE',
  'pcm_s24le': 'PCM 24-bit LE',
  'pcm_s24be': 'PCM 24-bit BE',
  'pcm_s32le': 'PCM 32-bit LE',
  'pcm_s32be': 'PCM 32-bit BE',
  'pcm_f32le': 'PCM 32-bit Float',
  'pcm_f64le': 'PCM 64-bit Float',
  'flac': 'FLAC',
  'alac': 'ALAC',
  'opus': 'Opus',
  'vorbis': 'Vorbis',
  'ac3': 'AC-3 / Dolby Digital',
  'eac3': 'E-AC-3 / Dolby Digital+',
  'dts': 'DTS',
  'truehd': 'Dolby TrueHD',
  'wmav2': 'WMA',
  'wmav1': 'WMA',
};

function friendlyCodecName(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/,/g, '');
  return CODEC_FRIENDLY_NAMES[key] || raw.toUpperCase();
}

// ---------------------------------------------------------------------------
// ProRes profile names mapped from FourCC
// ---------------------------------------------------------------------------
const PRORES_PROFILES = {
  'apco': 'ProRes 422 Proxy',
  'apcs': 'ProRes 422 LT',
  'apcn': 'ProRes 422',
  'apch': 'ProRes 422 HQ',
  'ap4h': 'ProRes 4444',
  'ap4x': 'ProRes 4444 XQ',
  // Also match from profile text in parentheses
  'proxy': 'ProRes 422 Proxy',
  'lt': 'ProRes 422 LT',
  'standard': 'ProRes 422',
  'hq': 'ProRes 422 HQ',
  '4444': 'ProRes 4444',
  '4444 xq': 'ProRes 4444 XQ',
};

// ---------------------------------------------------------------------------
// Probe a file with ffmpeg -i
// Returns { codec, codecFriendly, codecProfile, container, width, height,
//           fps, duration, bitrate, audioCodec, audioFriendly, audioDetails,
//           needsTranscode, isProRes, isDNx }
// ---------------------------------------------------------------------------
function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    const args = ['-i', filePath, '-hide_banner'];
    console.log('[Transcoder] Probing:', filePath);
    console.log('[Transcoder] Command:', FFMPEG, args.join(' '));

    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      // ffmpeg -i always exits with code 1 (no output file) — that's expected
      console.log('[Transcoder] Probe raw output:\n' + stderr);
      try {
        const info = parseProbeOutput(stderr, filePath);
        console.log('[Transcoder] Probe result:', JSON.stringify(info, null, 2));
        resolve(info);
      } catch (e) {
        console.error('[Transcoder] Probe parse error:', e.message);
        reject(e);
      }
    });

    proc.on('error', (err) => {
      console.error('[Transcoder] Probe spawn error:', err.message);
      reject(err);
    });
  });
}

function parseProbeOutput(output, filePath) {
  const info = {
    filePath,
    codec: null,
    codecFriendly: null,
    codecProfile: null,
    container: path.extname(filePath).toLowerCase().replace('.', ''),
    width: 0,
    height: 0,
    fps: 0,
    duration: 0,
    bitrate: null,
    audioCodec: null,
    audioFriendly: null,
    audioDetails: null,
    needsTranscode: false,
    isProRes: false,
    isDNx: false,
    sourceTimecode: null,       // e.g. "01:00:00:00"
    sourceTimecodeSeconds: 0,   // offset in seconds
  };

  // Duration & bitrate
  const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (durMatch) {
    info.duration =
      parseInt(durMatch[1]) * 3600 +
      parseInt(durMatch[2]) * 60 +
      parseInt(durMatch[3]) +
      parseInt(durMatch[4]) / 100;
  }

  const brMatch = output.match(/bitrate:\s*([\d.]+)\s*kb\/s/);
  if (brMatch) {
    info.bitrate = parseFloat(brMatch[1]);
  }

  // ── Video stream ──
  // Format examples:
  //   Stream #0:0[0x1]: Video: prores (HQ) (apch / 0x68637061), yuv444p10le(progressive), 1920x1080, ...
  //   Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p, 1280x720, ...
  //   Stream #0:0: Video: dnxhd (DNXHD) (AVdn / 0x6E645641), yuv422p, 1920x1080, ...
  
  // Step 1: Extract the codec name (first word after "Video: ")
  const codecMatch = output.match(/Video:\s*(\w+)/);
  if (codecMatch) {
    info.codec = codecMatch[1].toLowerCase();
    info.codecFriendly = friendlyCodecName(info.codec);
  }

  // Step 2: Extract profile/variant from parentheses after codec name
  // e.g., "prores (HQ)" → "HQ"  or "h264 (High 4:4:4 Predictive)" → "High 4:4:4 Predictive"
  const profileMatch = output.match(/Video:\s*\w+\s*\(([^)]+)\)/);
  if (profileMatch) {
    info.codecProfile = profileMatch[1].trim();
  }

  // Step 3: Extract FourCC from second set of parens
  // e.g., "(apch / 0x68637061)"
  const fourccMatch = output.match(/Video:\s*\w+(?:\s*\([^)]*\))?\s*\((\w+)\s*\//);
  let fourcc = fourccMatch ? fourccMatch[1].toLowerCase() : null;

  // Step 4: Extract resolution
  const resMatch = output.match(/(\d{2,5})x(\d{2,5})/);
  if (resMatch) {
    info.width = parseInt(resMatch[1]);
    info.height = parseInt(resMatch[2]);
  }

  // Step 5: Extract FPS
  const fpsMatch = output.match(/([\d.]+)\s+fps/);
  if (fpsMatch) {
    info.fps = parseFloat(fpsMatch[1]);
  }
  if (!info.fps) {
    const tbrMatch = output.match(/([\d.]+)\s+tbr/);
    if (tbrMatch) info.fps = parseFloat(tbrMatch[1]);
  }

  // ── Audio stream ──
  // Format: "Audio: pcm_s16le (sowt / ...), 44100 Hz, mono, s16, 705 kb/s"
  //         "Audio: aac (LC) (mp4a / ...), 44100 Hz, stereo, fltp, 128 kb/s"
  // Audio: pcm_s16le (sowt / 0x74776F73), 44100 Hz, mono, s16, 705 kb/s
  // Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s
  // Professional masters routinely carry audio as several discrete mono
  // tracks (a stereo pair as two mono streams, or 5.1 as six). ffmpeg's
  // default stream selection would keep only ONE of them, so the decoder needs
  // to know how many exist and how wide each is.
  const audioStreamLines = output.match(/Stream #\d+:\d+.*: Audio:.*/g) || [];
  info.audioStreamCount = audioStreamLines.length;
  info.audioChannelsTotal = audioStreamLines.reduce((total, line) => {
    if (/\b(\d+)(?:\.(\d+))? channels?\b/.test(line)) {
      const m = line.match(/\b(\d+)(?:\.(\d+))? channels?\b/);
      return total + parseInt(m[1], 10) + (m[2] ? parseInt(m[2], 10) : 0);
    }
    if (/\bmono\b/.test(line)) return total + 1;
    if (/\bstereo\b/.test(line)) return total + 2;
    if (/\b5\.1\b/.test(line)) return total + 6;
    if (/\b7\.1\b/.test(line)) return total + 8;
    if (/\bquad\b/.test(line)) return total + 4;
    return total + 1;   // unknown layout — assume one channel rather than zero
  }, 0);

  const audioLine = output.match(/Audio:\s*(.+)/);
  if (audioLine) {
    const aCodecMatch = audioLine[1].match(/^(\w+)/);
    if (aCodecMatch) {
      info.audioCodec = aCodecMatch[1].toLowerCase();
      info.audioFriendly = friendlyCodecName(info.audioCodec);
    }
    // Extract audio profile like (LC) — first parens group that is NOT a FourCC
    const aProfileMatch = audioLine[1].match(/^\w+\s*\(([^/\)]+)\)/);
    if (aProfileMatch && !aProfileMatch[1].match(/^0x/)) {
      const prof = aProfileMatch[1].trim();
      // Only append if it's a meaningful profile (not FourCC like "sowt / 0x...")
      if (prof.length <= 20 && !prof.includes('0x')) {
        info.audioFriendly += ' (' + prof + ')';
      }
    }
    // Extract sample rate, channels etc. after the last ), before end of line
    const detailsMatch = audioLine[1].match(/\),\s*(.+?)(?:\s*\(default\))?\s*$/);
    if (detailsMatch) {
      info.audioDetails = detailsMatch[1].trim().replace(/,\s*$/, '');
    }
  }

  // ── Detect ProRes ──
  if (info.codec === 'prores') {
    info.isProRes = true;
    info.needsTranscode = true;

    // Use FourCC for accurate profile identification
    if (fourcc && PRORES_PROFILES[fourcc]) {
      info.codecFriendly = PRORES_PROFILES[fourcc];
    } else if (info.codecProfile) {
      // Try profile text match
      const profLower = info.codecProfile.toLowerCase();
      for (const [key, name] of Object.entries(PRORES_PROFILES)) {
        if (profLower.includes(key)) {
          info.codecFriendly = name;
          break;
        }
      }
    }
    if (info.codecFriendly === 'Apple ProRes') {
      info.codecFriendly = 'ProRes 422'; // default if we can't determine variant
    }
  }

  // ── Detect DNxHD / DNxHR ──
  if (info.codec === 'dnxhd' || info.codec === 'vc3') {
    info.isDNx = true;
    info.needsTranscode = true;
    // DNxHR is the higher-res successor: typically >1080 or indicated in profile
    const profileLower = (info.codecProfile || '').toLowerCase();
    if (profileLower.includes('dnxhr') || profileLower.includes('hr') ||
        (info.height && info.height > 1080)) {
      info.codecFriendly = 'DNxHR';
      if (profileLower.includes('hq')) info.codecFriendly = 'DNxHR HQ';
      else if (profileLower.includes('sq')) info.codecFriendly = 'DNxHR SQ';
      else if (profileLower.includes('lb')) info.codecFriendly = 'DNxHR LB';
      else if (profileLower.includes('hqx')) info.codecFriendly = 'DNxHR HQX';
      else if (profileLower.includes('444')) info.codecFriendly = 'DNxHR 444';
    } else {
      info.codecFriendly = 'DNxHD';
    }
  }

  // ── Native playback decision ──
  //
  // Chromium can play a file directly only when ALL THREE hold: it demuxes the
  // container, it decodes the video codec, and it decodes the audio codec.
  // Miss any one and the file has to go through our own decoder.
  //
  // Audio is the one that bites quietly. Chromium has no AC-3, E-AC-3, DTS or
  // TrueHD decoder, so an MKV or MOV carrying those plays picture with SILENT
  // audio and raises no error at all — the worst possible outcome for a QC
  // player, because nothing looks wrong.
  //
  // Matroska is a deliberate inclusion: `canPlayType('video/x-matroska')`
  // returns "" in this Electron build, but Chromium sniffs file:// content
  // rather than trusting the MIME type and its FFmpeg demuxer does read MKV.
  // Verified playing H.264/AAC and VP9/Opus MKV natively.
  const nativeVideoCodecs = ['h264', 'avc1', 'vp8', 'vp9', 'av1', 'theora'];
  const nativeAudioCodecs = ['aac', 'mp3', 'mp4a', 'opus', 'vorbis', 'flac'];
  const nativeContainers = ['mp4', 'm4v', 'mov', 'webm', 'ogg', 'ogv', 'mkv'];

  // Linear PCM is decoded natively in every width and endianness tested
  // (s16le, s24le, s16be, f32le all play with audible audio in a MOV), and
  // uncompressed audio in a MOV is extremely common in professional masters.
  // Treating it as non-native sent those files through a full decode for no
  // reason — an H.264/PCM master that Chromium could have played instantly
  // instead had to be transcoded before it would start.
  // Exotic variants such as pcm_bluray only appear in containers that are not
  // on the native list anyway, so the container check still catches them.
  const isNativePcm = (codec) => /^pcm_[suf]\d+(le|be)?$/.test(codec || '');

  // ProRes/DNxHD/MXF handling above may already have decided; re-derive from
  // scratch so one rule owns the outcome instead of later lines silently
  // overriding earlier ones.
  const videoOk = !info.codec || nativeVideoCodecs.includes(info.codec);
  const audioOk = !info.audioCodec ||
    nativeAudioCodecs.includes(info.audioCodec) ||
    isNativePcm(info.audioCodec);
  const containerOk = !info.container || nativeContainers.includes(info.container);

  info.needsTranscode = !(videoOk && audioOk && containerOk);

  if (info.needsTranscode) {
    const reasons = [];
    if (!containerOk) reasons.push('container ' + info.container);
    if (!videoOk) reasons.push('video ' + info.codec);
    if (!audioOk) reasons.push('audio ' + info.audioCodec);
    info.transcodeReason = reasons.join(', ');
    console.log('[Transcoder] Not natively playable (' + info.transcodeReason + ') → decoding');
  } else {
    console.log('[Transcoder] Natively playable:', info.container, info.codec, info.audioCodec || '(no audio)');
  }

  // ── Source Timecode ──
  // Look for timecode in metadata tags (common in ProRes MOV, MXF, etc.)
  // Patterns:
  //   timecode        : 01:00:00:00
  //   timecode        : 01:00:00;00  (drop-frame with semicolon)
  // Can appear in format-level metadata or stream-level metadata (tmcd track)
  const tcMatch = output.match(/timecode\s*:\s*(\d{1,2}:\d{2}:\d{2}[;:]?\d{2})/i);
  if (tcMatch) {
    info.sourceTimecode = tcMatch[1];
    info.sourceTimecodeSeconds = parseTimecodeToSeconds(tcMatch[1], info.fps || 24);
    console.log('[Transcoder] Source timecode found:', info.sourceTimecode,
                '→', info.sourceTimecodeSeconds, 'seconds');
  }

  return info;
}

/**
 * Parse a timecode string (HH:MM:SS:FF or HH:MM:SS;FF) to seconds.
 * @param {string} tc - Timecode string like "01:00:00:00"
 * @param {number} fps - Frame rate for frame-to-seconds conversion
 * @returns {number} Total seconds represented by the timecode
 */
function parseTimecodeToSeconds(tc, fps) {
  if (!tc) return 0;
  // Support both : and ; as frame separator (semicolon = drop-frame)
  const parts = tc.split(/[:;]/);
  if (parts.length < 4) return 0;
  const hh = parseInt(parts[0]) || 0;
  const mm = parseInt(parts[1]) || 0;
  const ss = parseInt(parts[2]) || 0;
  const ff = parseInt(parts[3]) || 0;
  const roundedFps = Math.round(fps) || 24;
  return hh * 3600 + mm * 60 + ss + ff / roundedFps;
}

// ---------------------------------------------------------------------------
// Transcode a file to H.264 MP4 for HTML5 playback
// Returns the output path. Progress emitted via onProgress(pct).
// ---------------------------------------------------------------------------
function transcodeToH264(filePath, probeInfo, onProgress) {
  return new Promise((resolve, reject) => {
    const outputPath = makeTempPath('.mp4');
    const duration = probeInfo.duration || 0;

    console.log('[Transcoder] Transcoding:', filePath);
    console.log('[Transcoder] Output:', outputPath);
    console.log('[Transcoder] Duration:', duration, 'seconds');
    console.log('[Transcoder] Source codec:', probeInfo.codecFriendly || probeInfo.codec);

    const args = [
      '-y',
      '-i', filePath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      // Preserve resolution, ensure even dimensions
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      // Audio → AAC for broad compatibility
      '-c:a', 'aac',
      '-b:a', '192k',
      // MP4 fast-start for instant playback
      '-movflags', '+faststart',
      outputPath,
    ];

    console.log('[Transcoder] Command:', FFMPEG, args.join(' '));

    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let stderrBuf = '';

    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderrBuf += chunk;
      // Parse progress from the latest time= marker
      const timeMatches = chunk.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (timeMatches && duration > 0 && onProgress) {
        const cur = parseInt(timeMatches[1]) * 3600 +
                    parseInt(timeMatches[2]) * 60 +
                    parseInt(timeMatches[3]) +
                    parseInt(timeMatches[4]) / 100;
        const pct = Math.min(99, Math.round((cur / duration) * 100));
        onProgress(pct);
      }
    });

    proc.on('close', (code) => {
      console.log('[Transcoder] Transcode exit code:', code);
      if (code === 0 && fs.existsSync(outputPath)) {
        const stat = fs.statSync(outputPath);
        console.log('[Transcoder] Output file size:', (stat.size / 1024 / 1024).toFixed(1), 'MB');
        onProgress && onProgress(100);
        resolve(outputPath);
      } else {
        const errTail = stderrBuf.slice(-800);
        console.error('[Transcoder] Transcode FAILED. Last stderr:\n' + errTail);
        reject(new Error('Transcode failed (exit code ' + code + '):\n' + errTail));
      }
    });

    proc.on('error', (err) => {
      console.error('[Transcoder] Transcode spawn error:', err.message);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Image Sequence → Video
// ---------------------------------------------------------------------------

const IMAGE_SEQ_EXTENSIONS = ['.dpx', '.exr', '.tif', '.tiff', '.png', '.jpg', '.jpeg'];

/**
 * Given a single file from a sequence (e.g. frame_0001.dpx), detect all
 * members and return { pattern, startFrame, endFrame, count, fps, directory }.
 */
function detectImageSequence(sampleFilePath) {
  console.log('[Transcoder] Detecting image sequence from:', sampleFilePath);
  const dir = path.dirname(sampleFilePath);
  const base = path.basename(sampleFilePath);
  const ext = path.extname(base).toLowerCase();

  if (!IMAGE_SEQ_EXTENSIONS.includes(ext)) {
    console.log('[Transcoder] Extension not an image sequence type:', ext);
    return null;
  }

  // Find the numeric portion (e.g. "frame_0001.dpx" → prefix="frame_", digits="0001")
  const numMatch = base.match(/^(.*?)(\d+)(\.[^.]+)$/);
  if (!numMatch) {
    console.log('[Transcoder] No numeric pattern found in filename:', base);
    return null;
  }

  const prefix = numMatch[1];
  const digits = numMatch[2];
  const digitLen = digits.length;
  const suffix = numMatch[3];

  // Scan directory for all matching files
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (e) {
    console.error('[Transcoder] Cannot read directory:', dir, e.message);
    return null;
  }

  const regex = new RegExp(
    '^' + escapeRegex(prefix) + '(\\d{' + digitLen + '})' + escapeRegex(suffix) + '$', 'i'
  );

  const frameNumbers = [];
  for (const f of files) {
    const m = f.match(regex);
    if (m) frameNumbers.push(parseInt(m[1]));
  }

  console.log('[Transcoder] Found', frameNumbers.length, 'matching frames');

  if (frameNumbers.length < 2) return null;

  frameNumbers.sort((a, b) => a - b);
  const startFrame = frameNumbers[0];
  const endFrame = frameNumbers[frameNumbers.length - 1];

  // Build ffmpeg-compatible pattern:  dir/prefix%04d.ext
  const pattern = path.join(dir, prefix + '%0' + digitLen + 'd' + suffix);
  console.log('[Transcoder] Sequence pattern:', pattern);
  console.log('[Transcoder] Frames:', startFrame, '→', endFrame, '(' + frameNumbers.length + ' total)');

  return {
    pattern,
    directory: dir,
    prefix,
    suffix,
    digitLength: digitLen,
    startFrame,
    endFrame,
    count: frameNumbers.length,
    fps: 24,
    sampleFile: sampleFilePath,
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Render an image sequence to an H.264 MP4.
 */
function renderImageSequence(seqInfo, fps, onProgress) {
  return new Promise((resolve, reject) => {
    const outputPath = makeTempPath('.mp4');

    console.log('[Transcoder] Rendering image sequence:');
    console.log('[Transcoder]   Pattern:', seqInfo.pattern);
    console.log('[Transcoder]   FPS:', fps);
    console.log('[Transcoder]   Frames:', seqInfo.count);
    console.log('[Transcoder]   Output:', outputPath);

    const args = [
      '-y',
      '-framerate', String(fps),
      '-start_number', String(seqInfo.startFrame),
      '-i', seqInfo.pattern,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart',
      outputPath,
    ];

    const proc = spawn(FFMPEG, args, { windowsHide: true });
    let stderrBuf = '';

    proc.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderrBuf += chunk;
      // Parse frame= progress
      const frameMatch = chunk.match(/frame=\s*(\d+)/);
      if (frameMatch && seqInfo.count > 0 && onProgress) {
        const pct = Math.min(99, Math.round((parseInt(frameMatch[1]) / seqInfo.count) * 100));
        onProgress(pct);
      }
    });

    proc.on('close', (code) => {
      console.log('[Transcoder] Sequence render exit code:', code);
      if (code === 0 && fs.existsSync(outputPath)) {
        onProgress && onProgress(100);
        resolve(outputPath);
      } else {
        const errTail = stderrBuf.slice(-800);
        console.error('[Transcoder] Sequence render FAILED:\n' + errTail);
        reject(new Error('Image sequence render failed (exit ' + code + '):\n' + errTail));
      }
    });

    proc.on('error', (err) => {
      console.error('[Transcoder] Sequence render spawn error:', err.message);
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  FFMPEG,
  probeFile,
  transcodeToH264,
  detectImageSequence,
  renderImageSequence,
  cleanupTempFiles,
  IMAGE_SEQ_EXTENSIONS,
  makeTempPath,
};
