# PokitPlayer — Open-Source Component Inventory

**Product:** PokitPlayer 1.2.7  
**Owner:** Maiden Media Solutions INC.  
**Scope:** the desktop player only — every component that ships as part of an
installer to a customer machine (Windows NSIS/portable, macOS DMG/ZIP, Linux
AppImage/deb). Server-side and model components are out of scope for this file.  
**Generated:** 2026-09-03T05:42:24Z by `scripts/generate-oss-inventory.js`  
**Native binary evidence verified:** 2026-09-03

> Generated file — do not hand-edit. Re-run `npm run oss:inventory` after any
> dependency change. Native binary facts live in
> `scripts/oss-native-components.json`.

---

## Summary

| Measure | Count |
|---|---|
| Components shipped to customer machines | 25 |
| npm packages (production tree) | 16 |
| Native binaries / runtimes | 9 |
| **Non-distributable** | **0** |
| **Strong copyleft (GPL / AGPL / SSPL)** | **0** |
| Weak copyleft (LGPL / MPL / EPL) | 4 |
| Undetermined license | 0 |
| Components modified by us | 0 |

No component in the shipped build carries a GPL, AGPL, SSPL, non-commercial or
research-only license.
---

## Native binaries and runtimes

These are invisible to npm. `ffmpeg` and `ffprobe` are never linked against the
application — they are launched as separate child processes
(`child_process.spawn` / `execFile`) and communicated with over stdio only.
Call sites: `src/stream-decoder.js`, `src/transcoder.js`, `src/loudness.js`,
`src/captions.js`, `src/inspector.js`.

| Component | Version | License | Linkage | Modified | Platforms |
|---|---|---|---|---|---|
| Electron | 28.3.3 | `MIT` | runtime-bundled | no | win32-x64<br>darwin-x64<br>darwin-arm64<br>linux-x64 |
| Chromium | 120.0.6099.291 | `BSD-3-Clause AND OTHER` | runtime-bundled | no | win32-x64<br>darwin-x64<br>darwin-arm64<br>linux-x64 |
| Node.js | 18.18.2 | `MIT` | runtime-bundled | no | win32-x64<br>darwin-x64<br>darwin-arm64<br>linux-x64 |
| FFmpeg (Electron internal libffmpeg) | bundled with Electron 28.3.3 | `LGPL-2.1-or-later` | dynamic | no | win32-x64<br>darwin-x64<br>darwin-arm64<br>linux-x64 |
| FFmpeg CLI tools (ffmpeg + ffprobe) | N-126390-g9fc8c785e2-20260902 | `LGPL-3.0-or-later` | separate-process | no | win32-x64 |
| FFmpeg CLI tools (ffmpeg + ffprobe) | N-126390-g9fc8c785e2-20260902 | `LGPL-3.0-or-later` | separate-process | no | linux-x64 |
| FFmpeg CLI tools (ffmpeg + ffprobe) | 7.1.1 (built from source) | `LGPL-2.1-or-later` | separate-process | no | darwin-x64<br>darwin-arm64 |
| OpenH264 | bundled inside the FFmpeg CLI build | `BSD-2-Clause` | static (inside the bundled FFmpeg binary) | no | win32-x64<br>linux-x64 |
| libvpx | bundled inside the FFmpeg CLI build | `BSD-3-Clause` | static (inside the bundled FFmpeg binary) | no | win32-x64<br>linux-x64 |

---

## npm packages (production tree)

All 16 packages below are pure JavaScript, loaded via
`require()` into the Electron main process. None is a compiled native extension,
and none has been modified. Development dependencies are excluded: electron-builder
prunes them, so they never reach a customer machine.

| Package | Version | License | Class |
|---|---|---|---|
| `argparse` | 2.0.1 | `Python-2.0` | permissive |
| `builder-util-runtime` | 9.7.0 | `MIT` | permissive |
| `debug` | 4.4.3 | `MIT` | permissive |
| `electron-updater` | 6.8.9 | `MIT` | permissive |
| `fs-extra` | 10.1.0 | `MIT` | permissive |
| `graceful-fs` | 4.2.11 | `ISC` | permissive |
| `js-yaml` | 4.3.1 | `MIT` | permissive |
| `jsonfile` | 6.2.1 | `MIT` | permissive |
| `lazy-val` | 1.0.5 | `MIT` | permissive |
| `lodash.escaperegexp` | 4.1.2 | `MIT` | permissive |
| `lodash.isequal` | 4.5.0 | `MIT` | permissive |
| `ms` | 2.1.3 | `MIT` | permissive |
| `sax` | 1.6.1 | `BlueOak-1.0.0` | permissive |
| `semver` | 7.7.4 | `ISC` | permissive |
| `tiny-typed-emitter` | 2.1.0 | `MIT` | permissive |
| `universalify` | 2.0.1 | `MIT` | permissive |

---

## Method

- npm packages come from `package-lock.json`, production tree only.
- Native binary licenses were **not** taken from package metadata. Each was read
  out of the shipped binary itself with `strings -a <binary> | grep -- --enable-`,
  because FFmpeg compiles its `configure` line into the executable. That string is
  the authoritative record of what a given build actually contains.
- Re-run the binary check at any time with `npm run oss:verify`.
- Machine-readable equivalent: `docs/oss/pokitplayer.cdx.json` (CycloneDX 1.5).

