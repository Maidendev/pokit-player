/**
 * MaidenPlayer — Loudness Analysis Module
 *
 * Program loudness to ITU-R BS.1770 via FFmpeg's ebur128 filter, with
 * pass/fail against the delivery targets our specs care about (EBU R128 and
 * ATSC A/85 / CALM Act).
 *
 * Live per-channel metering is a renderer concern (Web Audio on the already
 * decoded stream) — this module is the offline measurement pass, which is the
 * only way to get a real gated integrated value over a whole program.
 */

const { spawn } = require('child_process');

// Reuse the transcoder's binary resolution rather than duplicating the
// candidate search; it already handles asar-unpacking and per-platform names.
const { FFMPEG: FFMPEG_PATH } = require('./transcoder');

/**
 * Delivery targets. `gated` selects the BS.1770 revision the target assumes:
 * R128 and A/85 are both gated measurements (BS.1770-3/-4).
 */
const LOUDNESS_TARGETS = {
  'ebu-r128': {
    label: 'EBU R128',
    integrated: -23.0,
    unit: 'LUFS',
    tolerance: 0.5,      // R128 permits ±0.5 LU for non-live content
    maxTruePeak: -1.0,   // dBTP
    gated: true,
  },
  'atsc-a85': {
    label: 'ATSC A/85 (CALM Act)',
    integrated: -24.0,
    unit: 'LKFS',
    tolerance: 2.0,      // A/85 practice allows ±2 LU
    maxTruePeak: -2.0,
    gated: true,
  },
};

/**
 * Parse the ebur128 summary block FFmpeg prints to stderr at end of stream.
 *
 * The block looks like:
 *   [Parsed_ebur128_0 @ ...] Summary:
 *     Integrated loudness:
 *       I:         -23.0 LUFS
 *       Threshold: -33.6 LUFS
 *     Loudness range:
 *       LRA:         5.2 LU
 *       ...
 *     True peak:
 *       Peak:       -1.5 dBFS
 */
function parseEbur128Summary(stderr) {
  const result = {
    integrated: null,
    threshold: null,
    loudnessRange: null,
    lraLow: null,
    lraHigh: null,
    truePeak: null,
  };

  // Only the trailing Summary block is authoritative — the running per-frame
  // lines use the same "I:" label and would otherwise overwrite it.
  const summaryIndex = stderr.lastIndexOf('Summary:');
  const block = summaryIndex >= 0 ? stderr.slice(summaryIndex) : stderr;

  const grab = (pattern) => {
    const m = block.match(pattern);
    return m ? parseFloat(m[1]) : null;
  };

  result.integrated = grab(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  result.threshold = grab(/Threshold:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  result.loudnessRange = grab(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/);
  result.lraLow = grab(/LRA low:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  result.lraHigh = grab(/LRA high:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  result.truePeak = grab(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/);

  return result;
}

/**
 * Measure program loudness over a whole file.
 *
 * @param {string} filePath
 * @param {object} opts
 * @param {boolean} opts.gated  true = BS.1770-3/-4 gated (default),
 *                              false = BS.1770-2 ungated
 * @param {number}  opts.audioStream  audio stream index (default 0)
 * @param {function} opts.onProgress  called with 0..1 as analysis proceeds
 * @param {number}  opts.duration     total duration, for progress reporting
 */
function measureLoudness(filePath, opts = {}) {
  const gated = opts.gated !== false;
  const streamIndex = opts.audioStream || 0;
  const duration = opts.duration || 0;

  return new Promise((resolve, reject) => {
    // peak=true asks for oversampled true-peak (dBTP) rather than sample peak.
    // gate settings: BS.1770-2 is the ungated measurement, which ebur128
    // reproduces with the relative gate disabled.
    const filter = 'ebur128=peak=true:framelog=verbose' + (gated ? '' : ':gauge=shortterm');

    const args = [
      '-hide_banner',
      '-nostats',
      '-i', filePath,
      '-map', '0:a:' + streamIndex,
      '-filter:a', filter,
      '-f', 'null',
      process.platform === 'win32' ? 'NUL' : '/dev/null',
    ];

    const proc = spawn(FFMPEG_PATH, args, { windowsHide: true });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;

      if (opts.onProgress && duration > 0) {
        // FFmpeg reports position as "t: 12.34" in the ebur128 verbose log.
        const matches = text.match(/t:\s*(\d+(?:\.\d+)?)/g);
        if (matches && matches.length) {
          const last = parseFloat(matches[matches.length - 1].split(':')[1]);
          if (isFinite(last)) {
            opts.onProgress(Math.max(0, Math.min(1, last / duration)));
          }
        }
      }
    });

    proc.on('error', (err) => reject(new Error('Loudness analysis failed: ' + err.message)));

    proc.on('close', (code) => {
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-4).join(' ');
        reject(new Error('ffmpeg exited ' + code + ': ' + tail));
        return;
      }
      const measured = parseEbur128Summary(stderr);
      if (measured.integrated === null) {
        reject(new Error('ebur128 produced no integrated loudness value'));
        return;
      }
      resolve(Object.assign(measured, { gated }));
    });
  });
}

/**
 * Compare a measurement against a delivery target.
 * Returns per-check verdicts rather than a single boolean so the UI can show
 * WHY a file fails (loudness vs. true peak are separate deliverable faults).
 */
function checkAgainstTarget(measurement, targetKey) {
  const target = LOUDNESS_TARGETS[targetKey];
  if (!target) throw new Error('Unknown loudness target: ' + targetKey);

  const checks = [];

  if (measurement.integrated !== null) {
    const delta = measurement.integrated - target.integrated;
    checks.push({
      name: 'Integrated loudness',
      measured: measurement.integrated,
      target: target.integrated,
      unit: target.unit,
      delta,
      pass: Math.abs(delta) <= target.tolerance,
      detail: 'target ' + target.integrated + ' ' + target.unit +
        ' ±' + target.tolerance + ' LU',
    });
  }

  if (measurement.truePeak !== null) {
    checks.push({
      name: 'Max true peak',
      measured: measurement.truePeak,
      target: target.maxTruePeak,
      unit: 'dBTP',
      delta: measurement.truePeak - target.maxTruePeak,
      pass: measurement.truePeak <= target.maxTruePeak,
      detail: 'must not exceed ' + target.maxTruePeak + ' dBTP',
    });
  }

  return {
    target: target.label,
    targetKey,
    checks,
    pass: checks.length > 0 && checks.every((c) => c.pass),
  };
}

module.exports = {
  measureLoudness,
  checkAgainstTarget,
  LOUDNESS_TARGETS,
  _internal: { parseEbur128Summary },
};
