#!/usr/bin/env node
'use strict';

/**
 * Licence gate for the bundled media binaries.
 *
 *   node scripts/verify-ffmpeg-license.js [--dir src/bin] [--quiet]
 *
 * Exits non-zero if any ffmpeg/ffprobe binary in the directory was built with a
 * flag that would make it GPL or non-distributable. Run it after fetching,
 * after building, and in CI before packaging.
 *
 * This is the guarantee the whole LGPL migration rests on. Pinned URLs and
 * checksums say where a binary came from; only this says what is actually in
 * it. FFmpeg compiles its `configure` line into the executable, so the check
 * reads the shipped artefact rather than trusting anyone's label — including
 * ours.
 *
 * Why each forbidden flag matters:
 *   --enable-nonfree  binary cannot be redistributed at all, under any licence
 *   --enable-gpl      relicenses the whole binary from LGPL to GPL
 *   --enable-libx264  x264 is GPL-2.0-or-later and forces --enable-gpl
 *   --enable-libx265  x265 is GPL-2.0-or-later and forces --enable-gpl
 *   (and the rest of the GPL-only external libraries)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const sources = JSON.parse(fs.readFileSync(path.join(__dirname, 'ffmpeg-sources.json'), 'utf8'));
const FORBIDDEN = sources.license.forbiddenFlags;

const args = process.argv.slice(2);
const QUIET = args.includes('--quiet');
const dirArg = args.indexOf('--dir');
const BIN_DIR = dirArg !== -1 && args[dirArg + 1]
  ? path.resolve(args[dirArg + 1])
  : path.join(ROOT, 'src', 'bin');

/**
 * Pull the compiled-in configure line out of a binary.
 *
 * `strings` is not available everywhere (notably a bare Windows runner), so
 * fall back to scanning the file ourselves. The configure line is plain ASCII
 * in the binary either way.
 */
function configurationOf(file) {
  try {
    const out = execFileSync('strings', ['-a', file], { maxBuffer: 512 * 1024 * 1024 }).toString();
    const m = out.match(/--(?:prefix|enable|disable|cc)=?[^\n]{40,}/);
    if (m) return m[0];
  } catch (_) { /* no strings(1); fall through to the manual scan */ }

  const buf = fs.readFileSync(file);
  // Printable-ASCII runs of 40+ chars, same idea as strings(1).
  const text = buf.toString('latin1');
  const m = text.match(/--(?:prefix|enable|disable|cc)=?[\x20-\x7e]{40,}/);
  return m ? m[0] : null;
}

function isMediaBinary(name) {
  return /^(ffmpeg|ffprobe)(-darwin(-(x64|arm64))?)?(\.exe)?$/.test(name);
}

function main() {
  if (!fs.existsSync(BIN_DIR)) {
    console.error('Licence gate: ' + path.relative(ROOT, BIN_DIR) + ' does not exist.');
    console.error('Run `npm run ffmpeg:fetch` first.');
    process.exit(1);
  }

  const binaries = fs.readdirSync(BIN_DIR)
    .filter(isMediaBinary)
    .map((n) => path.join(BIN_DIR, n));

  if (!binaries.length) {
    console.error('Licence gate: no ffmpeg/ffprobe binaries found in '
      + path.relative(ROOT, BIN_DIR) + '.');
    console.error('Run `npm run ffmpeg:fetch` first.');
    process.exit(1);
  }

  let failed = 0;

  for (const file of binaries) {
    const name = path.basename(file);
    const cfg = configurationOf(file);

    if (!cfg) {
      console.error('FAIL  ' + name + ' — no configure line found; cannot prove its licence.');
      failed++;
      continue;
    }

    const hits = FORBIDDEN.filter((flag) => cfg.includes(flag));
    if (hits.length) {
      console.error('FAIL  ' + name + ' — forbidden build flags: ' + hits.join(', '));
      if (cfg.includes('--enable-nonfree')) {
        console.error('      --enable-nonfree means this binary cannot be redistributed at all.');
      }
      failed++;
      continue;
    }

    if (!QUIET) {
      const version3 = cfg.includes('--enable-version3');
      console.log('OK    ' + name.padEnd(24)
        + (version3 ? 'LGPL-3.0-or-later' : 'LGPL-2.1-or-later'));
    }
  }

  if (failed) {
    console.error('\nLicence gate FAILED: ' + failed + ' of ' + binaries.length
      + ' binaries carry a forbidden build flag. These must not be packaged.');
    process.exit(1);
  }

  if (!QUIET) {
    console.log('\nLicence gate passed: ' + binaries.length
      + ' binaries, none GPL, none non-distributable.');
  }
}

main();
