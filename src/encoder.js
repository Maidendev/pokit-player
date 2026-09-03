/**
 * PokitPlayer — Video Encoder Selection
 *
 * Picks the video encoder used by the realtime playback pipeline
 * (stream-decoder.js) and by export/transcode (transcoder.js).
 *
 * WHY THIS MODULE EXISTS
 *
 * The playback path used to hardcode `-c:v libx264`. x264 is GPL-2.0-or-later
 * and forces FFmpeg's `--enable-gpl`, which is what made every bundled binary
 * GPL-3 rather than LGPL. Moving the player to LGPL therefore meant removing
 * x264, and removing x264 means choosing a replacement at runtime rather than
 * naming one at compile time — because the best available encoder differs by
 * machine, not just by platform.
 *
 * SELECTION ORDER
 *
 * Hardware H.264 first (it is both licence-clean and faster than x264
 * ultrafast was), then software H.264 via OpenH264, then VP9 as a last
 * resort. Every candidate is LGPL-compatible:
 *
 *   h264_videotoolbox  macOS, Apple            (OS framework)
 *   h264_nvenc         NVIDIA                  (LGPL headers, driver-provided)
 *   h264_qsv           Intel Quick Sync        (MIT libvpl)
 *   h264_amf           AMD                     (MIT AMF SDK)
 *   libopenh264        software, Cisco         (BSD-2-Clause)
 *   libvpx-vp9         software, Google        (BSD-3-Clause)
 *
 * Presence in `ffmpeg -encoders` is necessary but NOT sufficient: a binary
 * built with nvenc still lists h264_nvenc on a machine with no NVIDIA card.
 * So each candidate is confirmed with a one-frame test encode before it is
 * chosen. That costs a few hundred milliseconds once per session and turns a
 * mid-playback failure into a startup decision.
 *
 * A note on the software fallback: OpenH264 is slower than x264 ultrafast was.
 * On a machine with any usable GPU the hardware path is faster than the old
 * behaviour; on a GPU-less machine, realtime transcode of large formats may be
 * slower than before. That is the honest cost of leaving GPL.
 */

'use strict';

const { execFileSync, spawnSync } = require('child_process');

// Encoders we refuse to use even if the binary offers them. Defence in depth:
// if a GPL FFmpeg is ever swapped in by mistake, the player still will not
// reach for the GPL-only encoders. The licence gate on the binary is the real
// control; this is the second lock.
const FORBIDDEN_ENCODERS = ['libx264', 'libx265', 'libxvid', 'libxavs', 'libxavs2'];

/**
 * Candidates in priority order.
 *
 * Two argument sets per encoder, because the two callers want opposite things:
 *   realtime — stream-decoder.js, feeding MSE. Latency over quality.
 *   quality  — transcoder.js, writing a file. Quality over speed.
 *
 * x264's `-preset ultrafast -tune zerolatency -crf` vocabulary is shared by
 * none of these, which is why the old inline flags could not simply have the
 * codec name swapped.
 */
const CANDIDATES = [
  {
    name: 'h264_videotoolbox',
    platforms: ['darwin'],
    hardware: true,
    mseVideoCodec: 'avc1.640029',
    // VideoToolbox has no CRF; it is bitrate-driven. -realtime keeps latency
    // low, which is what the playback pipeline needs.
    realtime: ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-b:v', '20M',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
    quality: ['-c:v', 'h264_videotoolbox', '-b:v', '40M',
      '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'h264_nvenc',
    platforms: ['win32', 'linux'],
    hardware: true,
    mseVideoCodec: 'avc1.640029',
    realtime: ['-c:v', 'h264_nvenc', '-preset', 'p1', '-tune', 'ull', '-rc', 'vbr',
      '-cq', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
    quality: ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr',
      '-cq', '19', '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'h264_qsv',
    platforms: ['win32', 'linux'],
    hardware: true,
    mseVideoCodec: 'avc1.640029',
    realtime: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23',
      '-profile:v', 'high', '-pix_fmt', 'nv12'],
    quality: ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', '19',
      '-profile:v', 'high', '-pix_fmt', 'nv12'],
  },
  {
    name: 'h264_amf',
    platforms: ['win32'],
    hardware: true,
    mseVideoCodec: 'avc1.640029',
    realtime: ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp',
      '-qp_i', '23', '-qp_p', '23', '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
    quality: ['-c:v', 'h264_amf', '-quality', 'quality', '-rc', 'cqp',
      '-qp_i', '19', '-qp_p', '19', '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'libopenh264',
    platforms: ['darwin', 'win32', 'linux'],
    hardware: false,
    mseVideoCodec: 'avc1.640029',
    // OpenH264 is bitrate-driven, not CRF-driven. Verified to emit High
    // profile, so the avc1.6400xx codec string stays correct.
    realtime: ['-c:v', 'libopenh264', '-b:v', '20M', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p'],
    quality: ['-c:v', 'libopenh264', '-b:v', '40M', '-profile:v', 'high',
      '-pix_fmt', 'yuv420p'],
  },
  {
    name: 'libvpx-vp9',
    platforms: ['darwin', 'win32', 'linux'],
    hardware: false,
    // VP9 in fMP4. Chromium decodes this in MSE, so the pipeline downstream
    // is unchanged — only the codec string the renderer declares differs.
    mseVideoCodec: 'vp09.00.41.08',
    realtime: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8',
      '-row-mt', '1', '-b:v', '20M', '-pix_fmt', 'yuv420p'],
    // VP9 CRF mode requires an explicit -b:v 0.
    quality: ['-c:v', 'libvpx-vp9', '-deadline', 'good', '-cpu-used', '2',
      '-row-mt', '1', '-b:v', '0', '-crf', '24', '-pix_fmt', 'yuv420p'],
  },
];

let cached = null;

/**
 * Encoders this ffmpeg binary was built with. Cheap; one process.
 */
function listEncoders(ffmpegPath) {
  try {
    const out = execFileSync(ffmpegPath, ['-hide_banner', '-encoders'],
      { timeout: 15000, windowsHide: true }).toString();
    const names = new Set();
    for (const line of out.split('\n')) {
      // " V....D name  Description"
      const m = line.match(/^\s*[VAS][.A-Z]{5}\s+(\S+)/);
      if (m) names.add(m[1]);
    }
    return names;
  } catch (err) {
    console.error('[Encoder] Could not list encoders:', err.message);
    return new Set();
  }
}

/**
 * Confirm an encoder actually runs on THIS machine, not merely that it was
 * compiled in. One frame of synthetic video, discarded.
 */
function testEncode(ffmpegPath, candidate) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
    '-frames:v', '1',
    ...candidate.realtime,
    '-f', 'null', '-',
  ];
  const r = spawnSync(ffmpegPath, args, { timeout: 20000, windowsHide: true });
  return r.status === 0;
}

/**
 * Choose the encoder. Cached for the life of the process — the answer cannot
 * change while the app is running, and the test encodes are not free.
 *
 * Returns null only if no LGPL-compatible encoder works at all, which means
 * the bundled binary is broken or missing.
 */
function selectVideoEncoder(ffmpegPath) {
  if (cached !== null) return cached;

  const available = listEncoders(ffmpegPath);

  for (const name of FORBIDDEN_ENCODERS) {
    if (available.has(name)) {
      // Not fatal — the binary still might be LGPL with an unrelated library —
      // but it is a strong signal that a GPL build has been substituted.
      console.warn('[Encoder] WARNING: bundled ffmpeg offers ' + name
        + ', which is GPL. Refusing to use it. Run `npm run ffmpeg:verify`.');
    }
  }

  const platform = process.platform;
  const eligible = CANDIDATES.filter((c) =>
    c.platforms.includes(platform)
    && available.has(c.name)
    && !FORBIDDEN_ENCODERS.includes(c.name));

  for (const candidate of eligible) {
    if (testEncode(ffmpegPath, candidate)) {
      console.log('[Encoder] Using ' + candidate.name
        + (candidate.hardware ? ' (hardware)' : ' (software)')
        + ' → ' + candidate.mseVideoCodec);
      cached = candidate;
      return cached;
    }
    console.log('[Encoder] ' + candidate.name + ' present but not usable here — skipping.');
  }

  console.error('[Encoder] No usable LGPL-compatible video encoder found.');
  console.error('[Encoder] Available: ' + [...available].slice(0, 40).join(', '));
  cached = null;
  return null;
}

/**
 * Video encoding arguments for the selected encoder, or the empty array if
 * none is usable (callers should treat that as fatal).
 *
 * @param {string} ffmpegPath
 * @param {'realtime'|'quality'} mode  realtime for MSE playback, quality for
 *                                     file output.
 */
function videoEncoderArgs(ffmpegPath, mode = 'realtime') {
  const enc = selectVideoEncoder(ffmpegPath);
  if (!enc) return [];
  const args = mode === 'quality' ? enc.quality : enc.realtime;
  return args.slice();
}

/**
 * The MSE mime type the renderer must declare for the stream this encoder
 * produces. Kept here so the codec string and the encoder can never drift
 * apart — that pairing is the thing most likely to break silently.
 */
function mseCodecString(ffmpegPath, hasAudio) {
  const enc = selectVideoEncoder(ffmpegPath);
  const video = enc ? enc.mseVideoCodec : 'avc1.640029';
  return hasAudio
    ? 'video/mp4; codecs="' + video + ',mp4a.40.2"'
    : 'video/mp4; codecs="' + video + '"';
}

/** Test seam — lets a test force re-selection. */
function resetCache() {
  cached = null;
}

module.exports = {
  selectVideoEncoder,
  videoEncoderArgs,
  mseCodecString,
  resetCache,
  CANDIDATES,
  FORBIDDEN_ENCODERS,
};
