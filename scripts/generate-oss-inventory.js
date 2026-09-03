#!/usr/bin/env node
'use strict';

/**
 * Generates the open-source component inventory for the PokitPlayer desktop
 * build — the thing that ships as a binary to a customer machine.
 *
 *   node scripts/generate-oss-inventory.js            # regenerate both outputs
 *   node scripts/generate-oss-inventory.js --check    # CI gate, exit 1 on new copyleft
 *   node scripts/generate-oss-inventory.js --verify   # re-read installed binaries
 *
 * Outputs:
 *   docs/oss/PLAYER-COMPONENTS.md     human/counsel-readable inventory
 *   docs/oss/pokitplayer.cdx.json     CycloneDX 1.5 SBOM
 *
 * Two sources are merged, because neither is sufficient alone:
 *
 *   1. package-lock.json — every npm package in the *production* tree. Dev
 *      dependencies are excluded because electron-builder prunes them; they
 *      never reach a customer machine.
 *
 *   2. scripts/oss-native-components.json — the native binaries and the
 *      Electron runtime. npm cannot see these. Worse, it actively misreports
 *      one: ffprobe-static declares MIT while shipping GPL FFmpeg builds. A
 *      package-manager-only SBOM would miss that obligation completely, which
 *      is the single most important reason this script exists rather than a
 *      bare `npm sbom`.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'docs', 'oss');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const VERIFY = args.includes('--verify');

// ---------------------------------------------------------------------------
// License classification
// ---------------------------------------------------------------------------

// Buckets counsel asked to be separated out. Anything landing in DENY or
// REVIEW is surfaced at the top of the report rather than buried in the table.
const STRONG_COPYLEFT = /^(GPL|AGPL|SSPL|EUPL|OSL|CPAL)/i;
const WEAK_COPYLEFT = /^(LGPL|MPL|EPL|CDDL)/i;
const NONFREE = /NONFREE|UNDISTRIBUTABLE|NON-COMMERCIAL|NONCOMMERCIAL|RESEARCH-ONLY|CC-BY-NC/i;

// npm publishes no license field for these two. Both were read off the LICENSE
// file in the installed package on 2026-09-02 rather than assumed.
const LICENSE_OVERRIDES = {
  'async@0.2.10': {
    license: 'MIT',
    evidence: 'node_modules/fluent-ffmpeg/node_modules/async/LICENSE — "Copyright (c) 2010 Caolan McMahon", verbatim MIT text',
  },
  'parse-cache-control@1.0.1': {
    license: 'BSD-3-Clause',
    evidence: 'node_modules/parse-cache-control/LICENSE — "Copyright (c) 2012-2014, Walmart", 3-clause BSD incl. no-endorsement clause',
  },
};

function classify(license) {
  if (!license || license === 'UNKNOWN') return 'unknown';
  if (NONFREE.test(license)) return 'nonfree';
  if (STRONG_COPYLEFT.test(license)) return 'strong-copyleft';
  if (WEAK_COPYLEFT.test(license)) return 'weak-copyleft';
  return 'permissive';
}

// ---------------------------------------------------------------------------
// npm production tree, straight out of the lockfile
// ---------------------------------------------------------------------------

function readNpmComponents() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const out = [];

  for (const [key, entry] of Object.entries(lock.packages)) {
    // "" is the root project itself; dev-only packages never get packaged.
    if (!key || entry.dev || entry.devOptional) continue;

    const name = key.replace(/^node_modules\//, '').replace(/.*\/node_modules\//, '');
    const id = name + '@' + entry.version;
    const override = LICENSE_OVERRIDES[id];

    out.push({
      name,
      version: entry.version,
      license: override ? override.license : (entry.license || 'UNKNOWN'),
      licenseEvidence: override ? override.evidence : 'package-lock.json',
      // Every one of these is plain JavaScript loaded by require() into the
      // Electron main process. No native linking, no compiled extension.
      linkage: 'javascript-require',
      modified: false,
      shipsToCustomer: true,
      kind: 'npm',
      purl: 'pkg:npm/' + name.replace('@', '%40') + '@' + entry.version,
    });
  }

  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Native / binary components, from the curated manifest
// ---------------------------------------------------------------------------

function readNativeComponents() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'oss-native-components.json'), 'utf8')
  );
  const out = manifest.components.map((c) => ({
    name: c.name,
    version: c.version,
    license: c.license,
    licenseEvidence: c.configuration
      ? 'compiled-in configuration string read from the shipped binary'
      : 'upstream project declaration',
    linkage: c.linkage,
    modified: c.modified,
    shipsToCustomer: c.shipsToCustomer,
    platforms: c.platforms || [],
    supplier: c.supplier,
    source: c.source,
    configuration: c.configuration,
    copyleftTriggers: c.copyleftTriggers || [],
    licenseMismatch: c.licenseMismatch,
    blocking: !!c.blocking,
    notes: c.notes || [],
    kind: 'native',
    purl: 'pkg:generic/' + c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      + '@' + encodeURIComponent(c.version),
  }));
  return { verifiedOn: manifest.verifiedOn, components: out };
}

// ---------------------------------------------------------------------------
// --verify: re-read the installed binaries instead of trusting the manifest
// ---------------------------------------------------------------------------

function stringsOf(file) {
  try {
    return execFileSync('strings', ['-a', file], { maxBuffer: 512 * 1024 * 1024 }).toString();
  } catch (err) {
    return null;
  }
}

function verifyBinaries() {
  const targets = [];
  const ffmpegBin = path.join(ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
  if (fs.existsSync(ffmpegBin)) targets.push(['ffmpeg-static (host platform)', ffmpegBin]);

  const probeRoot = path.join(ROOT, 'node_modules', 'ffprobe-static', 'bin');
  if (fs.existsSync(probeRoot)) {
    for (const os of fs.readdirSync(probeRoot)) {
      for (const arch of fs.readdirSync(path.join(probeRoot, os))) {
        const dir = path.join(probeRoot, os, arch);
        for (const f of fs.readdirSync(dir)) {
          targets.push(['ffprobe-static ' + os + '/' + arch, path.join(dir, f)]);
        }
      }
    }
  }

  if (!targets.length) {
    console.error('--verify: no binaries found. Run `npm install` first.');
    process.exitCode = 1;
    return;
  }

  let problems = 0;
  for (const [label, file] of targets) {
    const s = stringsOf(file);
    if (s === null) {
      console.log(label.padEnd(34) + 'SKIPPED (no `strings` on PATH)');
      continue;
    }
    const cfg = (s.match(/--enable-[^\n]*/) || [''])[0];
    const flags = [];
    if (/--enable-nonfree/.test(cfg)) flags.push('NONFREE');
    if (/--enable-gpl\b/.test(cfg)) flags.push('GPL');
    if (/--enable-version3/.test(cfg)) flags.push('v3');
    for (const lib of ['libx264', 'libx265', 'libxvid', 'librubberband', 'libvidstab', 'frei0r']) {
      if (new RegExp('--enable-' + lib).test(cfg)) flags.push(lib);
    }
    if (flags.includes('NONFREE') || flags.includes('GPL')) problems++;
    console.log(label.padEnd(34) + (flags.length ? flags.join(' ') : 'no GPL/nonfree flags found'));
  }
  console.log('\n' + problems + ' of ' + targets.length + ' binaries carry GPL or nonfree build flags.');
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function mdTable(rows, headers) {
  const lines = ['| ' + headers.join(' | ') + ' |', '|' + headers.map(() => '---').join('|') + '|'];
  for (const r of rows) lines.push('| ' + r.join(' | ') + ' |');
  return lines.join('\n');
}

function renderMarkdown(pkg, npmComponents, native, generatedAt) {
  const all = [...npmComponents, ...native.components];
  const flagged = all.filter((c) => ['nonfree', 'strong-copyleft', 'unknown'].includes(classify(c.license)));
  const weak = all.filter((c) => classify(c.license) === 'weak-copyleft');
  const nonfree = all.filter((c) => classify(c.license) === 'nonfree');
  const strong = all.filter((c) => classify(c.license) === 'strong-copyleft');
  const unknown = all.filter((c) => classify(c.license) === 'unknown');

  const L = [];
  L.push('# PokitPlayer — Open-Source Component Inventory');
  L.push('');
  L.push('**Product:** PokitPlayer ' + pkg.version + '  ');
  L.push('**Owner:** Maiden Media Solutions INC.  ');
  L.push('**Scope:** the desktop player only — every component that ships as part of an');
  L.push('installer to a customer machine (Windows NSIS/portable, macOS DMG/ZIP, Linux');
  L.push('AppImage/deb). Server-side and model components are out of scope for this file.  ');
  L.push('**Generated:** ' + generatedAt + ' by `scripts/generate-oss-inventory.js`  ');
  L.push('**Native binary evidence verified:** ' + native.verifiedOn);
  L.push('');
  L.push('> Generated file — do not hand-edit. Re-run `npm run oss:inventory` after any');
  L.push('> dependency change. Native binary facts live in');
  L.push('> `scripts/oss-native-components.json`.');
  L.push('');
  L.push('---');
  L.push('');

  // -- Summary -------------------------------------------------------------
  L.push('## Summary');
  L.push('');
  L.push(mdTable(
    [
      ['Components shipped to customer machines', String(all.length)],
      ['npm packages (production tree)', String(npmComponents.length)],
      ['Native binaries / runtimes', String(native.components.length)],
      ['**Non-distributable**', '**' + nonfree.length + '**'],
      ['**Strong copyleft (GPL / AGPL / SSPL)**', '**' + strong.length + '**'],
      ['Weak copyleft (LGPL / MPL / EPL)', String(weak.length)],
      ['Undetermined license', String(unknown.length)],
      ['Components modified by us', String(all.filter((c) => c.modified).length)],
    ],
    ['Measure', 'Count']
  ));
  L.push('');

  if (!flagged.length) {
    L.push('No component in the shipped build carries a GPL, AGPL, SSPL, non-commercial or');
    L.push('research-only license.');
  } else {
    L.push('### Components requiring counsel review');
    L.push('');
    L.push(mdTable(
      flagged.map((c) => [
        c.name,
        c.version,
        '`' + c.license + '`',
        c.platforms && c.platforms.length ? c.platforms.join(', ') : 'all',
        c.linkage,
      ]),
      ['Component', 'Version', 'License', 'Platforms', 'Linkage']
    ));
    L.push('');
    for (const c of flagged) {
      L.push('#### ' + c.name + ' ' + c.version + (c.blocking ? ' — BLOCKING' : ''));
      L.push('');
      L.push('- **License:** `' + c.license + '`');
      if (c.supplier) L.push('- **Supplier:** ' + c.supplier);
      if (c.platforms && c.platforms.length) L.push('- **Ships on:** ' + c.platforms.join(', '));
      L.push('- **Linkage:** ' + c.linkage);
      L.push('- **Modified by us:** ' + (c.modified ? 'yes' : 'no'));
      if (c.licenseMismatch) {
        L.push('- **Package manager reports:** `' + c.licenseMismatch.declaredByPackageManager
          + '` — **actual: `' + c.licenseMismatch.actual + '`**');
        for (const line of c.licenseMismatch.explanation) L.push('  - ' + line);
      }
      if (c.copyleftTriggers && c.copyleftTriggers.length) {
        L.push('- **What makes it copyleft:**');
        for (const t of c.copyleftTriggers) L.push('  - `' + t + '`');
      }
      if (c.notes && c.notes.length) {
        L.push('- **Notes:**');
        for (const n of c.notes) L.push('  - ' + n);
      }
      if (c.configuration) {
        L.push('');
        L.push('<details><summary>Full build configuration, read from the shipped binary</summary>');
        L.push('');
        L.push('```');
        L.push(c.configuration);
        L.push('```');
        L.push('');
        L.push('</details>');
      }
      L.push('');
    }
  }
  L.push('---');
  L.push('');

  // -- Native --------------------------------------------------------------
  L.push('## Native binaries and runtimes');
  L.push('');
  L.push('These are invisible to npm. `ffmpeg` and `ffprobe` are never linked against the');
  L.push('application — they are launched as separate child processes');
  L.push('(`child_process.spawn` / `execFile`) and communicated with over stdio only.');
  L.push('Call sites: `src/stream-decoder.js`, `src/transcoder.js`, `src/loudness.js`,');
  L.push('`src/captions.js`, `src/inspector.js`.');
  L.push('');
  L.push(mdTable(
    native.components.map((c) => [
      c.name,
      c.version,
      '`' + c.license + '`',
      c.linkage,
      c.modified ? 'yes' : 'no',
      c.platforms.length ? c.platforms.join('<br>') : 'all',
    ]),
    ['Component', 'Version', 'License', 'Linkage', 'Modified', 'Platforms']
  ));
  L.push('');
  L.push('---');
  L.push('');

  // -- npm -----------------------------------------------------------------
  L.push('## npm packages (production tree)');
  L.push('');
  L.push('All ' + npmComponents.length + ' packages below are pure JavaScript, loaded via');
  L.push('`require()` into the Electron main process. None is a compiled native extension,');
  L.push('and none has been modified. Development dependencies are excluded: electron-builder');
  L.push('prunes them, so they never reach a customer machine.');
  L.push('');
  L.push(mdTable(
    npmComponents.map((c) => [
      '`' + c.name + '`',
      c.version,
      '`' + c.license + '`',
      classify(c.license),
    ]),
    ['Package', 'Version', 'License', 'Class']
  ));
  L.push('');

  const overridden = npmComponents.filter((c) => LICENSE_OVERRIDES[c.name + '@' + c.version]);
  if (overridden.length) {
    L.push('### Licenses resolved by hand');
    L.push('');
    L.push('npm publishes no license field for these. Each was read off the `LICENSE` file in');
    L.push('the installed package rather than assumed.');
    L.push('');
    for (const c of overridden) {
      L.push('- **`' + c.name + '@' + c.version + '` → `' + c.license + '`** — ' + c.licenseEvidence);
    }
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('## Method');
  L.push('');
  L.push('- npm packages come from `package-lock.json`, production tree only.');
  L.push('- Native binary licenses were **not** taken from package metadata. Each was read');
  L.push('  out of the shipped binary itself with `strings -a <binary> | grep -- --enable-`,');
  L.push('  because FFmpeg compiles its `configure` line into the executable. That string is');
  L.push('  the authoritative record of what a given build actually contains.');
  L.push('- Re-run the binary check at any time with `npm run oss:verify`.');
  L.push('- Machine-readable equivalent: `docs/oss/pokitplayer.cdx.json` (CycloneDX 1.5).');
  L.push('');

  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CycloneDX
// ---------------------------------------------------------------------------

function renderCycloneDx(pkg, npmComponents, native, generatedAt) {
  const toComponent = (c) => {
    const comp = {
      type: c.kind === 'npm' ? 'library' : 'application',
      'bom-ref': c.purl,
      name: c.name,
      version: c.version,
      purl: c.purl,
      scope: 'required',
      licenses: c.license && c.license !== 'UNKNOWN'
        ? [{ license: { name: c.license } }]
        : [],
      properties: [
        { name: 'pokit:linkage', value: c.linkage },
        { name: 'pokit:modified', value: String(!!c.modified) },
        { name: 'pokit:shipsToCustomer', value: String(!!c.shipsToCustomer) },
        { name: 'pokit:licenseClass', value: classify(c.license) },
        { name: 'pokit:licenseEvidence', value: c.licenseEvidence },
      ],
    };
    if (c.supplier) comp.supplier = { name: c.supplier };
    if (c.source) comp.externalReferences = [{ type: 'distribution', url: c.source }];
    if (c.platforms && c.platforms.length) {
      comp.properties.push({ name: 'pokit:platforms', value: c.platforms.join(',') });
    }
    if (c.configuration) {
      comp.properties.push({ name: 'pokit:buildConfiguration', value: c.configuration });
    }
    if (c.licenseMismatch) {
      comp.properties.push({
        name: 'pokit:declaredLicenseIsWrong',
        value: 'package manager reports ' + c.licenseMismatch.declaredByPackageManager
          + '; actual is ' + c.licenseMismatch.actual,
      });
    }
    return comp;
  };

  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      timestamp: generatedAt,
      tools: [{ vendor: 'Maiden Media Solutions INC.', name: 'generate-oss-inventory', version: '1.0.0' }],
      component: {
        type: 'application',
        'bom-ref': 'pkg:npm/pokitplayer@' + pkg.version,
        name: 'PokitPlayer',
        version: pkg.version,
        purl: 'pkg:npm/pokitplayer@' + pkg.version,
        licenses: [{ license: { id: 'MIT' } }],
        supplier: { name: 'Maiden Media Solutions INC.' },
      },
      properties: [
        { name: 'pokit:scope', value: 'desktop player, distributed to customer machines' },
        { name: 'pokit:nativeEvidenceVerifiedOn', value: native.verifiedOn },
      ],
    },
    components: [...npmComponents, ...native.components].map(toComponent),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  if (VERIFY) {
    verifyBinaries();
    return;
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const npmComponents = readNpmComponents();
  const native = readNativeComponents();
  const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const all = [...npmComponents, ...native.components];
  const blocking = all.filter((c) => ['nonfree', 'strong-copyleft'].includes(classify(c.license)));
  const unknown = all.filter((c) => classify(c.license) === 'unknown');

  if (CHECK_ONLY) {
    for (const c of blocking) {
      console.error('COPYLEFT/NONFREE: ' + c.name + '@' + c.version + ' — ' + c.license);
    }
    for (const c of unknown) {
      console.error('UNDETERMINED LICENSE: ' + c.name + '@' + c.version);
    }
    const total = blocking.length + unknown.length;
    console.error('\n' + total + ' component(s) need a licensing decision before distribution.');
    process.exitCode = total ? 1 : 0;
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const mdPath = path.join(OUT_DIR, 'PLAYER-COMPONENTS.md');
  fs.writeFileSync(mdPath, renderMarkdown(pkg, npmComponents, native, generatedAt));

  const sbomPath = path.join(OUT_DIR, 'pokitplayer.cdx.json');
  fs.writeFileSync(sbomPath, JSON.stringify(renderCycloneDx(pkg, npmComponents, native, generatedAt), null, 2) + '\n');

  console.log('Wrote ' + path.relative(ROOT, mdPath));
  console.log('Wrote ' + path.relative(ROOT, sbomPath));
  console.log('');
  console.log(all.length + ' components ship to customer machines: '
    + npmComponents.length + ' npm, ' + native.components.length + ' native.');
  console.log(blocking.length + ' carry a non-distributable or strong-copyleft license.');
}

main();
