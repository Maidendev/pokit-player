/**
 * MaidenPlayer — Media Inspector Module
 *
 * Deep media inspection via ffprobe JSON, feeding the "Check It" panel.
 * This is the structured-metadata substrate the QC features build on:
 * broad-format playback decisions, loudness, GOP analysis and AS-11.
 *
 * transcoder.js keeps its own lightweight `ffmpeg -i` stderr parse, which is
 * what the playback path uses to decide "can the <video> element handle this".
 * That parse cannot see clean aperture, color metadata, channel layouts or
 * side data, so inspection gets a real ffprobe instead of extending the regex.
 *
 * ffprobe is resolved the same way transcoder.js resolves ffmpeg: a bundled
 * platform binary in src/bin first, then the ffprobe-static npm package, then
 * whatever is on PATH.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// ---------------------------------------------------------------------------
// ffprobe binary resolution
// ---------------------------------------------------------------------------

function getFfprobePath() {
  const platform = process.platform;
  const binDir = path.join(__dirname, 'bin');
  // asarUnpack extracts to app.asar.unpacked/ in packed builds.
  const binDirUnpacked = binDir.includes('app.asar')
    ? binDir.replace('app.asar', 'app.asar.unpacked')
    : binDir;

  const exe = platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const candidates = [];

  if (platform === 'darwin') {
    // Match transcoder.js: arch-specific binary first, then generic.
    candidates.push(path.join(binDirUnpacked, 'ffprobe-darwin-' + process.arch));
    candidates.push(path.join(binDir, 'ffprobe-darwin-' + process.arch));
    candidates.push(path.join(binDirUnpacked, 'ffprobe-darwin'));
    candidates.push(path.join(binDir, 'ffprobe-darwin'));
  } else {
    candidates.push(path.join(binDirUnpacked, exe));
    candidates.push(path.join(binDir, exe));
  }
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'bin', exe));
  }

  try {
    let npmPath = require('ffprobe-static').path;
    if (npmPath) {
      if (npmPath.includes('app.asar')) {
        npmPath = npmPath.replace('app.asar', 'app.asar.unpacked');
      }
      candidates.push(npmPath);
    }
  } catch (_) { /* not installed */ }

  for (const fp of candidates) {
    try {
      if (fs.existsSync(fp)) {
        console.log('[Inspector] ✓ Found ffprobe at:', fp);
        return fp;
      }
    } catch (_) { /* ignore */ }
  }

  console.log('[Inspector] No bundled ffprobe found, falling back to PATH:', exe);
  return exe;
}

const FFPROBE = getFfprobePath();

// ffprobe JSON on a long MXF/TS can be large; 64 MB of stdout is plenty.
const MAX_BUFFER = 64 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30000;

function runFfprobe(args, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE, args, { maxBuffer: MAX_BUFFER, timeout, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && !stdout) {
          reject(new Error(err.killed
            ? 'ffprobe timed out after ' + (timeout / 1000) + 's'
            : (stderr || err.message).toString().trim().split('\n').slice(-3).join(' ')));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('ffprobe returned unparseable JSON: ' + e.message));
        }
      });
  });
}

// ---------------------------------------------------------------------------
// Value formatting helpers
// ---------------------------------------------------------------------------

// ffprobe reports rationals as "30000/1001"; collapse to a number.
function ratioToNumber(str) {
  if (!str || typeof str !== 'string') return null;
  const [num, den] = str.split('/').map(Number);
  if (!isFinite(num) || !isFinite(den) || den === 0) return null;
  return num / den;
}

// The frame rates the player's timecode math already handles.
const STANDARD_RATES = [23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 100, 119.88, 120];

// Snap to the NEAREST standard rate, and only within a tolerance tighter than
// the 0.024 gap between a pulled-down rate and its integer neighbour — a loose
// "first match wins" scan reports true 24p as 23.976 and breaks timecode.
function snapFrameRate(fps) {
  if (!fps || !isFinite(fps) || fps <= 0) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const rate of STANDARD_RATES) {
    const delta = Math.abs(fps - rate);
    if (delta < bestDelta) { bestDelta = delta; best = rate; }
  }
  if (best !== null && bestDelta < 0.01) return best;
  return Math.round(fps * 1000) / 1000;
}

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// pix_fmt encodes both chroma subsampling and bit depth: yuv422p10le → 4:2:2, 10-bit.
function parsePixFmt(pixFmt) {
  if (!pixFmt) return { subsampling: null, bitDepth: null };
  let subsampling = null;
  if (/444/.test(pixFmt)) subsampling = '4:4:4';
  else if (/422/.test(pixFmt)) subsampling = '4:2:2';
  else if (/440/.test(pixFmt)) subsampling = '4:4:0';
  else if (/420/.test(pixFmt)) subsampling = '4:2:0';
  else if (/411/.test(pixFmt)) subsampling = '4:1:1';
  else if (/^gray/.test(pixFmt)) subsampling = 'Monochrome';
  else if (/^(rgb|bgr|gbr)/.test(pixFmt)) subsampling = 'RGB (4:4:4)';

  const depthMatch = pixFmt.match(/(\d+)(le|be)$/);
  let bitDepth = depthMatch ? parseInt(depthMatch[1], 10) : null;
  if (bitDepth === null && /^(yuv|yuvj|rgb|bgr|gbr|gray)/.test(pixFmt)) bitDepth = 8;
  return { subsampling, bitDepth };
}

const SCAN_TYPES = {
  progressive: 'Progressive',
  tt: 'Interlaced — top field first',
  bb: 'Interlaced — bottom field first',
  tb: 'Interlaced — top coded first, bottom displayed first',
  bt: 'Interlaced — bottom coded first, top displayed first',
};

function describeScanType(stream) {
  const fieldOrder = stream.field_order;
  if (fieldOrder && SCAN_TYPES[fieldOrder]) return SCAN_TYPES[fieldOrder];
  if (fieldOrder === 'unknown' || !fieldOrder) return null;
  return fieldOrder;
}

// Greatest common divisor, for reducing a display aspect ratio.
function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

function aspectRatio(w, h) {
  if (!w || !h) return null;
  const d = gcd(w, h);
  return (w / d) + ':' + (h / d);
}

const HDR_TRANSFERS = {
  smpte2084: 'PQ (SMPTE ST 2084)',
  'arib-std-b67': 'HLG (ARIB STD-B67)',
  smpte428: 'SMPTE ST 428-1 (D-Cinema)',
  bt709: 'BT.709',
  bt470bg: 'BT.470 BG',
  'iec61966-2-1': 'sRGB (IEC 61966-2-1)',
  linear: 'Linear',
};

/**
 * Detect the HDR flavor from color metadata plus side data. Dolby Vision and
 * HDR10+ are carried as side data / dynamic metadata rather than as a transfer
 * characteristic, so both signals have to be checked.
 */
function detectHdrFormat(stream, extraSideData) {
  const sideData = (stream.side_data_list || []).concat(extraSideData || []);
  const flavors = [];

  const hasDoVi = sideData.some((sd) =>
    /dovi|dolby vision/i.test(sd.side_data_type || ''));
  if (hasDoVi) {
    const dv = sideData.find((sd) => /dovi|dolby vision/i.test(sd.side_data_type || ''));
    const profile = dv && (dv.dv_profile !== undefined ? dv.dv_profile : dv.profile);
    flavors.push('Dolby Vision' + (profile !== undefined ? ' (profile ' + profile + ')' : ''));
  }

  const hasHdr10Plus = sideData.some((sd) =>
    /hdr dynamic metadata|hdr10\+|smpte2094/i.test(sd.side_data_type || ''));
  if (hasHdr10Plus) flavors.push('HDR10+');

  const transfer = stream.color_transfer;
  const hasMastering = sideData.some((sd) =>
    /mastering display/i.test(sd.side_data_type || ''));
  if (transfer === 'smpte2084') {
    flavors.push(hasMastering ? 'HDR10' : 'PQ (no mastering display metadata)');
  } else if (transfer === 'arib-std-b67') {
    flavors.push('HLG');
  }

  return flavors.length ? flavors.join(' + ') : null;
}

// Side data values arrive as rationals ("34000/50000") or plain numbers.
function sideDataValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v;
  const r = ratioToNumber(String(v));
  return r !== null ? r : num(v);
}

/**
 * Mastering display + content light level, the HDR10 static metadata set.
 * In HEVC these ride in SEI messages, so they are attached to FRAMES, not to
 * the stream — the caller merges in first-frame side data before calling this.
 */
function extractHdrMetadata(sideDataList) {
  const out = {};
  for (const sd of sideDataList || []) {
    const type = (sd.side_data_type || '').toLowerCase();
    if (type.includes('mastering display')) {
      out.masteringDisplay = {
        redX: sideDataValue(sd.red_x), redY: sideDataValue(sd.red_y),
        greenX: sideDataValue(sd.green_x), greenY: sideDataValue(sd.green_y),
        blueX: sideDataValue(sd.blue_x), blueY: sideDataValue(sd.blue_y),
        whiteX: sideDataValue(sd.white_point_x), whiteY: sideDataValue(sd.white_point_y),
        // Luminance is reported in cd/m² once the rational is resolved.
        maxLuminance: sideDataValue(sd.max_luminance),
        minLuminance: sideDataValue(sd.min_luminance),
      };
    } else if (type.includes('content light level')) {
      out.contentLightLevel = {
        maxCLL: sideDataValue(sd.max_content),
        maxFALL: sideDataValue(sd.max_average),
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Clean aperture — the "active picture" rectangle inside the coded frame. MOV
 * carries it as a clap atom, which ffprobe surfaces as CPB side data on some
 * builds; otherwise it can be derived from the coded vs. display size.
 */
function extractCleanAperture(stream) {
  const clap = (stream.side_data_list || []).find((sd) =>
    /clean aperture|clap/i.test(sd.side_data_type || ''));
  if (clap) {
    return {
      width: clap.width || clap.apertureWidth,
      height: clap.height || clap.apertureHeight,
      source: 'clap atom',
    };
  }
  // codec_width/height are the coded dimensions; width/height are post-crop.
  const codedW = num(stream.codec_width);
  const codedH = num(stream.codec_height);
  const dispW = num(stream.width);
  const dispH = num(stream.height);
  if (codedW && dispW && (codedW !== dispW || codedH !== dispH)) {
    return { width: dispW, height: dispH, codedWidth: codedW, codedHeight: codedH, source: 'coded vs display size' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Codec naming — friendly labels for the formats pro deliveries actually use
// ---------------------------------------------------------------------------

const PRORES_PROFILES = {
  0: 'ProRes 422 Proxy',
  1: 'ProRes 422 LT',
  2: 'ProRes 422',
  3: 'ProRes 422 HQ',
  4: 'ProRes 4444',
  5: 'ProRes 4444 XQ',
};

function friendlyVideoCodec(stream) {
  const name = (stream.codec_name || '').toLowerCase();
  const profile = stream.profile;
  const tag = (stream.codec_tag_string || '').toLowerCase();

  if (name === 'prores') {
    // ffprobe reports the ProRes profile either numerically or by name.
    const byNumber = PRORES_PROFILES[num(profile)];
    if (byNumber) return byNumber;
    if (profile) return 'ProRes ' + profile;
    const byTag = { apco: 'ProRes 422 Proxy', apcs: 'ProRes 422 LT', apcn: 'ProRes 422',
      apch: 'ProRes 422 HQ', ap4h: 'ProRes 4444', ap4x: 'ProRes 4444 XQ' }[tag];
    return byTag || 'Apple ProRes';
  }
  if (name === 'dnxhd') {
    // DNxHR profiles come through as LB/SQ/HQ/HQX/444; plain DNxHD does not.
    if (profile && /dnxhr/i.test(profile)) return profile.toUpperCase().replace('DNXHR', 'DNxHR ');
    return profile ? 'DNxHD (' + profile + ')' : 'Avid DNxHD';
  }
  if (name === 'jpeg2000' || name === 'j2k') return 'JPEG 2000';
  if (name === 'h264') return 'H.264/AVC' + (profile ? ' (' + profile + ')' : '');
  if (name === 'hevc') return 'HEVC/H.265' + (profile ? ' (' + profile + ')' : '');
  if (name === 'mpeg2video') return 'MPEG-2 Video' + (profile ? ' (' + profile + ')' : '');
  if (name === 'vc1') return 'SMPTE VC-1';
  if (name.startsWith('wmv')) return 'Windows Media Video ' + name.replace('wmv', '');
  if (name === 'mpeg4') return 'MPEG-4 Part 2' + (profile ? ' (' + profile + ')' : '');
  return (stream.codec_long_name || stream.codec_name || 'Unknown');
}

function friendlyAudioCodec(stream) {
  const name = (stream.codec_name || '').toLowerCase();
  const map = {
    pcm_s16le: 'PCM 16-bit', pcm_s24le: 'PCM 24-bit', pcm_s32le: 'PCM 32-bit',
    aac: 'AAC', ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)',
    truehd: 'Dolby TrueHD', dts: 'DTS', mp2: 'MPEG-1 Layer II', mp3: 'MP3',
    flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis', wmav2: 'Windows Media Audio 9',
  };
  return map[name] || (stream.codec_long_name || stream.codec_name || 'Unknown');
}

// Per-channel speaker labels, which the QC panel shows next to the meters.
const CHANNEL_LAYOUTS = {
  mono: ['C'],
  stereo: ['L', 'R'],
  '2.1': ['L', 'R', 'LFE'],
  '3.0': ['L', 'R', 'C'],
  quad: ['L', 'R', 'Ls', 'Rs'],
  '4.0': ['L', 'R', 'C', 'Cs'],
  '5.0': ['L', 'R', 'C', 'Ls', 'Rs'],
  '5.1': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
  '5.1(side)': ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'],
  '6.1': ['L', 'R', 'C', 'LFE', 'Cs', 'Ls', 'Rs'],
  '7.1': ['L', 'R', 'C', 'LFE', 'Lb', 'Rb', 'Ls', 'Rs'],
};

function speakerLabels(stream) {
  const layout = (stream.channel_layout || '').toLowerCase();
  if (CHANNEL_LAYOUTS[layout]) return CHANNEL_LAYOUTS[layout];
  const count = num(stream.channels) || 0;
  // Discrete/unlabelled tracks (common in MXF) just get numbered channels.
  return Array.from({ length: count }, (_, i) => 'Ch ' + (i + 1));
}

// ---------------------------------------------------------------------------
// Timecode
// ---------------------------------------------------------------------------

/**
 * Start timecode can live in the container tags, a stream's tags, or a
 * dedicated data stream (MXF and MOV both do the latter).
 */
function findStartTimecode(probe) {
  const fromFormat = probe.format && probe.format.tags &&
    (probe.format.tags.timecode || probe.format.tags['com.apple.quicktime.timecode']);
  if (fromFormat) return fromFormat;

  for (const stream of probe.streams || []) {
    const tc = stream.tags && stream.tags.timecode;
    if (tc) return tc;
  }
  return null;
}

function findReelName(probe) {
  const sources = [probe.format && probe.format.tags];
  for (const stream of probe.streams || []) sources.push(stream.tags);
  for (const tags of sources) {
    if (!tags) continue;
    const key = Object.keys(tags).find((k) => /reel[_ ]?name|reel/i.test(k));
    if (key && tags[key]) return tags[key];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main inspection entry point
// ---------------------------------------------------------------------------

/**
 * Full inspection of a media file. Returns a structured model; the renderer
 * decides which parts to show in the summary vs. the advanced section.
 */
async function inspectFile(filePath) {
  const probe = await runFfprobe([
    '-hide_banner',
    '-loglevel', 'error',
    '-show_format',
    '-show_streams',
    '-show_chapters',
    '-show_programs',
    '-print_format', 'json',
    filePath,
  ]);

  const streams = probe.streams || [];
  const format = probe.format || {};

  // HDR10 mastering-display and content-light-level metadata are SEI messages
  // carried per-frame, so -show_streams alone never reports them. One extra
  // single-frame probe is cheap and is the only way to see them.
  const firstFrameSideData = await probeFirstFrameSideData(filePath);

  const video = streams.filter((s) => s.codec_type === 'video')
    .map((s, i) => mapVideoStream(s, i === 0 ? firstFrameSideData : []));
  const audio = streams.filter((s) => s.codec_type === 'audio').map(mapAudioStream);
  const subtitle = streams.filter((s) => s.codec_type === 'subtitle').map(mapSubtitleStream);
  const data = streams.filter((s) => s.codec_type === 'data').map(mapDataStream);

  return {
    filePath,
    container: {
      formatName: format.format_name || null,
      formatLongName: format.format_long_name || null,
      duration: num(format.duration),
      size: num(format.size),
      bitrate: num(format.bit_rate),
      startTime: num(format.start_time),
      nbStreams: num(format.nb_streams),
      startTimecode: findStartTimecode(probe),
      reelName: findReelName(probe),
      tags: format.tags || {},
    },
    video,
    audio,
    subtitle,
    data,
    chapters: (probe.chapters || []).map((c) => ({
      id: c.id,
      start: num(c.start_time),
      end: num(c.end_time),
      title: (c.tags && c.tags.title) || null,
    })),
    // MPEG-TS programs carry the PID/PMT structure QC operators look for.
    programs: (probe.programs || []).map((p) => ({
      programId: p.program_id,
      programNum: p.program_num,
      pmtPid: p.pmt_pid,
      pcrPid: p.pcr_pid,
      tags: p.tags || {},
      streamIndexes: (p.streams || []).map((s) => s.index),
    })),
  };
}

/**
 * Read side data off the first video frame only. Bounded by -read_intervals so
 * it never walks the whole file; failure is non-fatal (a file with no readable
 * first frame simply reports no HDR metadata).
 */
async function probeFirstFrameSideData(filePath) {
  try {
    const probe = await runFfprobe([
      '-hide_banner',
      '-loglevel', 'error',
      '-read_intervals', '%+#1',
      '-select_streams', 'v:0',
      '-show_frames',
      '-show_entries', 'frame=side_data_list',
      '-print_format', 'json',
      filePath,
    ], 15000);
    const frame = (probe.frames || [])[0];
    return (frame && frame.side_data_list) || [];
  } catch (e) {
    console.warn('[Inspector] First-frame side data probe failed:', e.message);
    return [];
  }
}

function mapVideoStream(s, extraSideData) {
  const { subsampling, bitDepth } = parsePixFmt(s.pix_fmt);
  const fps = snapFrameRate(ratioToNumber(s.r_frame_rate));
  const width = num(s.width);
  const height = num(s.height);
  const sar = s.sample_aspect_ratio && s.sample_aspect_ratio !== '0:1' ? s.sample_aspect_ratio : null;
  const dar = s.display_aspect_ratio && s.display_aspect_ratio !== '0:1'
    ? s.display_aspect_ratio
    : aspectRatio(width, height);

  return {
    index: s.index,
    codec: s.codec_name || null,
    codecFriendly: friendlyVideoCodec(s),
    profile: s.profile !== undefined ? String(s.profile) : null,
    level: s.level !== undefined && s.level !== -99 ? s.level : null,
    codecTag: s.codec_tag_string || null,
    width, height,
    codedWidth: num(s.codec_width),
    codedHeight: num(s.codec_height),
    displayAspectRatio: dar,
    pixelAspectRatio: sar,
    cleanAperture: extractCleanAperture(s),
    frameRate: fps,
    avgFrameRate: snapFrameRate(ratioToNumber(s.avg_frame_rate)),
    scanType: describeScanType(s),
    fieldOrder: s.field_order || null,
    pixelFormat: s.pix_fmt || null,
    chromaSubsampling: subsampling,
    bitDepth: num(s.bits_per_raw_sample) || bitDepth,
    colorPrimaries: s.color_primaries || null,
    colorTransfer: s.color_transfer ? (HDR_TRANSFERS[s.color_transfer] || s.color_transfer) : null,
    colorMatrix: s.color_space || null,
    colorRange: s.color_range || null,
    hdrFormat: detectHdrFormat(s, extraSideData),
    hdrMetadata: extractHdrMetadata((s.side_data_list || []).concat(extraSideData || [])),
    bitrate: num(s.bit_rate),
    nbFrames: num(s.nb_frames),
    duration: num(s.duration),
    // has_b_frames > 0 means long-GOP; 0 means intra-only (ProRes, DNxHR, J2K).
    hasBFrames: num(s.has_b_frames),
    isIntraOnly: num(s.has_b_frames) === 0,
    tags: s.tags || {},
  };
}

function mapAudioStream(s) {
  return {
    index: s.index,
    codec: s.codec_name || null,
    codecFriendly: friendlyAudioCodec(s),
    profile: s.profile || null,
    channels: num(s.channels),
    channelLayout: s.channel_layout || null,
    speakerLabels: speakerLabels(s),
    sampleRate: num(s.sample_rate),
    bitDepth: num(s.bits_per_raw_sample) || num(s.bits_per_sample) || null,
    sampleFormat: s.sample_fmt || null,
    bitrate: num(s.bit_rate),
    duration: num(s.duration),
    language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || null,
    title: (s.tags && s.tags.title) || null,
    tags: s.tags || {},
  };
}

function mapSubtitleStream(s) {
  return {
    index: s.index,
    codec: s.codec_name || null,
    codecLongName: s.codec_long_name || null,
    language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) || null,
    title: (s.tags && s.tags.title) || null,
    // Disposition flags are how SDH / hearing-impaired variants are signalled.
    isForced: !!(s.disposition && s.disposition.forced),
    isHearingImpaired: !!(s.disposition && s.disposition.hearing_impaired),
    isVisualImpaired: !!(s.disposition && s.disposition.visual_impaired),
    tags: s.tags || {},
  };
}

function mapDataStream(s) {
  return {
    index: s.index,
    codec: s.codec_name || null,
    codecTag: s.codec_tag_string || null,
    // A timecode track shows up as a data stream with a timecode tag.
    isTimecode: !!(s.tags && s.tags.timecode),
    timecode: (s.tags && s.tags.timecode) || null,
    tags: s.tags || {},
  };
}

/**
 * Per-frame picture type and packet size for the GOP / data-rate strip.
 * Reading frames is expensive, so callers pass a bounded time window.
 */
async function probeFrames(filePath, startTime = 0, duration = 10, streamIndex = 0) {
  const probe = await runFfprobe([
    '-hide_banner',
    '-loglevel', 'error',
    '-read_intervals', startTime + '%+' + duration,
    '-select_streams', 'v:' + streamIndex,
    '-show_entries', 'frame=pict_type,pkt_size,pts_time,key_frame,best_effort_timestamp_time',
    '-print_format', 'json',
    filePath,
  ], 60000);

  return (probe.frames || []).map((f) => ({
    pictType: f.pict_type || null,
    size: num(f.pkt_size),
    time: num(f.pts_time) !== null ? num(f.pts_time) : num(f.best_effort_timestamp_time),
    isKeyFrame: f.key_frame === 1,
  }));
}

/** Is a usable ffprobe actually present? Drives graceful degradation in the UI. */
function isAvailable() {
  return new Promise((resolve) => {
    execFile(FFPROBE, ['-hide_banner', '-version'], { timeout: 5000, windowsHide: true },
      (err) => resolve(!err));
  });
}

module.exports = {
  inspectFile,
  probeFrames,
  isAvailable,
  getFfprobePath,
  // Exported for reuse by the loudness and AS-11 modules.
  _internal: { runFfprobe, snapFrameRate, ratioToNumber, speakerLabels },
};
