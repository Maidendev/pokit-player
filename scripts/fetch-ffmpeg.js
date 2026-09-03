#!/usr/bin/env node
'use strict';

/**
 * Fetches the LGPL ffmpeg + ffprobe binaries for the host platform into src/bin/.
 *
 *   node scripts/fetch-ffmpeg.js                      # fetch for this platform
 *   node scripts/fetch-ffmpeg.js --platform win32-x64 # fetch for another
 *   node scripts/fetch-ffmpeg.js --update-checksums   # re-pin after upstream rebuild
 *   node scripts/fetch-ffmpeg.js --force              # re-download even if present
 *
 * Replaces the ffmpeg-static and ffprobe-static npm packages. Those resolved
 * their download by *host architecture at install time*, which is how an
 * arm64 --enable-nonfree binary ended up inside the Intel macOS DMG. Here the
 * platform is explicit, the URL and checksum are pinned, and nothing is
 * accepted until it passes the licence gate.
 *
 * macOS is built from source instead of downloaded — see build-ffmpeg-macos.sh.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BIN_DIR = path.join(ROOT, 'src', 'bin');
const CACHE_DIR = path.join(ROOT, '.ffmpeg-cache');
const SOURCES_PATH = path.join(__dirname, 'ffmpeg-sources.json');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const UPDATE_CHECKSUMS = argv.includes('--update-checksums');
const platArg = argv.indexOf('--platform');

function hostPlatform() {
  const p = process.platform;
  const a = process.arch;
  if (p === 'win32') return 'win32-x64';
  if (p === 'darwin') return 'darwin-' + (a === 'arm64' ? 'arm64' : 'x64');
  if (p === 'linux') return 'linux-x64';
  throw new Error('Unsupported platform: ' + p + '-' + a);
}

const TARGET = platArg !== -1 && argv[platArg + 1] ? argv[platArg + 1] : hostPlatform();

// ---------------------------------------------------------------------------

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    let redirects = 0;

    const get = (u) => {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      const opts = { headers: { 'user-agent': 'pokitplayer-fetch-ffmpeg' } };

      https.get(proxy ? u : u, opts, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (++redirects > 10) return reject(new Error('too many redirects'));
          res.resume();
          return get(new URL(res.headers.location, u).toString());
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode + ' for ' + u));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let seen = 0;
        let lastPct = -1;
        res.on('data', (c) => {
          seen += c.length;
          if (total) {
            const pct = Math.floor((seen / total) * 100);
            if (pct >= lastPct + 10) {
              lastPct = pct;
              process.stdout.write('  ' + pct + '%\r');
            }
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    };

    get(url);
  });
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extract(archivePath, kind, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (kind === 'zip') {
    // PowerShell on Windows runners, unzip elsewhere.
    if (process.platform === 'win32') {
      execFileSync('powershell', ['-NoProfile', '-Command',
        'Expand-Archive -LiteralPath "' + archivePath + '" -DestinationPath "' + destDir + '" -Force'],
        { stdio: 'inherit' });
    } else {
      execFileSync('unzip', ['-o', '-q', archivePath, '-d', destDir], { stdio: 'inherit' });
    }
  } else if (kind === 'tar.xz') {
    execFileSync('tar', ['-xf', archivePath, '-C', destDir], { stdio: 'inherit' });
  } else {
    throw new Error('Unknown archive kind: ' + kind);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const sources = JSON.parse(fs.readFileSync(SOURCES_PATH, 'utf8'));
  const spec = sources.platforms[TARGET];

  if (!spec) {
    console.error('No source pinned for platform: ' + TARGET);
    console.error('Known: ' + Object.keys(sources.platforms).join(', '));
    process.exit(1);
  }

  if (spec.method === 'build') {
    console.log(TARGET + ' is built from source, not downloaded.');
    console.log('Run: ' + spec.script);
    console.log('(macOS has no published LGPL FFmpeg build — see ffmpeg-sources.json.)');
    process.exit(0);
  }

  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const targets = Object.keys(spec.extract).map((n) => path.join(BIN_DIR, n));
  if (!FORCE && !UPDATE_CHECKSUMS && targets.every((t) => fs.existsSync(t))) {
    console.log('Binaries already present in src/bin — skipping download.');
    console.log('Use --force to re-fetch.');
    return runGate();
  }

  const base = process.env.FFMPEG_MIRROR_BASE;
  const url = base
    ? base.replace(/\/$/, '') + '/' + path.basename(spec.url)
    : spec.url;

  const archivePath = path.join(CACHE_DIR, path.basename(spec.url));

  if (FORCE || !fs.existsSync(archivePath)) {
    console.log('Downloading ' + TARGET + ' LGPL build');
    console.log('  ' + url);
    await download(url, archivePath);
  } else {
    console.log('Using cached archive: ' + path.relative(ROOT, archivePath));
  }

  const actual = sha256(archivePath);

  if (UPDATE_CHECKSUMS) {
    spec.sha256 = actual;
    spec.verifiedOn = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(SOURCES_PATH, JSON.stringify(sources, null, 2) + '\n');
    console.log('Re-pinned ' + TARGET + ' sha256 = ' + actual);
    console.log('Licence gate still has to pass before this is safe to ship.');
  } else if (spec.sha256 && actual !== spec.sha256) {
    console.error('\nCHECKSUM MISMATCH for ' + TARGET);
    console.error('  expected ' + spec.sha256);
    console.error('  actual   ' + actual);
    console.error('\nUpstream republished this artefact, or it was tampered with.');
    console.error('Do not work around this by editing the pin. Review the new build,');
    console.error('confirm it still passes the licence gate, then re-pin with:');
    console.error('  npm run ffmpeg:fetch -- --update-checksums');
    process.exit(1);
  } else if (!spec.sha256) {
    console.error('No checksum pinned for ' + TARGET + '. Computed: ' + actual);
    console.error('Record it with --update-checksums before shipping.');
    process.exit(1);
  }

  const workDir = path.join(CACHE_DIR, TARGET);
  fs.rmSync(workDir, { recursive: true, force: true });
  extract(archivePath, spec.archive, workDir);

  for (const [outName, inPath] of Object.entries(spec.extract)) {
    const from = path.join(workDir, inPath);
    const to = path.join(BIN_DIR, outName);
    if (!fs.existsSync(from)) {
      console.error('Archive layout changed — expected ' + inPath + ' inside the archive.');
      process.exit(1);
    }
    fs.copyFileSync(from, to);
    if (process.platform !== 'win32') fs.chmodSync(to, 0o755);
    console.log('  → src/bin/' + outName);
  }

  // The LGPL text has to travel with the binaries we redistribute.
  for (const [outName, inPath] of Object.entries(spec.noticeFiles || {})) {
    const from = path.join(workDir, inPath);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(BIN_DIR, outName));
      console.log('  → src/bin/' + outName);
    }
  }

  runGate();
}

function runGate() {
  console.log('\nRunning licence gate...');
  const r = spawnSync(process.execPath,
    [path.join(__dirname, 'verify-ffmpeg-license.js')],
    { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('Licence gate failed — these binaries must not be packaged.');
    process.exit(r.status || 1);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
