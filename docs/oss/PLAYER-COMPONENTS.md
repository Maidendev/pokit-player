# PokitPlayer — Open-Source Component Inventory

**Product:** PokitPlayer 1.2.7  
**Owner:** Maiden Media Solutions INC.  
**Scope:** the desktop player only — every component that ships as part of an
installer to a customer machine (Windows NSIS/portable, macOS DMG/ZIP, Linux
AppImage/deb). Server-side and model components are out of scope for this file.  
**Generated:** 2026-09-03T01:12:57Z by `scripts/generate-oss-inventory.js`  
**Native binary evidence verified:** 2026-09-02

> Generated file — do not hand-edit. Re-run `npm run oss:inventory` after any
> dependency change. Native binary facts live in
> `scripts/oss-native-components.json`.

---

## Summary

| Measure | Count |
|---|---|
| Components shipped to customer machines | 49 |
| npm packages (production tree) | 39 |
| Native binaries / runtimes | 10 |
| **Non-distributable** | **1** |
| **Strong copyleft (GPL / AGPL / SSPL)** | **6** |
| Weak copyleft (LGPL / MPL / EPL) | 1 |
| Undetermined license | 0 |
| Components modified by us | 0 |

### Components requiring counsel review

| Component | Version | License | Platforms | Linkage |
|---|---|---|---|---|
| ffmpeg-static | 5.3.0 | `GPL-3.0-or-later` | all | javascript-require |
| FFmpeg (bundled CLI) | 6.1.1-essentials_build-www.gyan.dev | `GPL-3.0-or-later` | win32-x64 | separate-process |
| FFmpeg (bundled CLI) | 6.1.1-tessus | `GPL-3.0-or-later` | darwin-x64 | separate-process |
| FFmpeg (bundled CLI) | 6.0 (libavcodec 60.3.100) | `GPL-3.0-or-later AND NONFREE-UNDISTRIBUTABLE` | darwin-arm64 | separate-process |
| FFmpeg (bundled CLI) | 7.0.2-static | `GPL-3.0-or-later` | linux-x64 | separate-process |
| ffprobe (bundled CLI) | 4.0.2 (libavcodec 58.18.100) | `GPL-3.0-or-later` | win32-x64, win32-ia32, linux-x64, linux-ia32, darwin-x64 | separate-process |
| ffprobe (bundled CLI) | 4.4 (libavcodec 58.134.100), Tessus build | `GPL-3.0-or-later` | darwin-arm64 | separate-process |

#### ffmpeg-static 5.3.0

- **License:** `GPL-3.0-or-later`
- **Linkage:** javascript-require
- **Modified by us:** no

#### FFmpeg (bundled CLI) 6.1.1-essentials_build-www.gyan.dev

- **License:** `GPL-3.0-or-later`
- **Supplier:** gyan.dev, via ffmpeg-static 5.3.0 (release tag b6.1.1)
- **Ships on:** win32-x64
- **Linkage:** separate-process
- **Modified by us:** no
- **What makes it copyleft:**
  - `--enable-gpl`
  - `--enable-version3`
  - `--enable-libx264 (GPL-2.0-or-later)`
  - `--enable-libx265 (GPL-2.0-or-later)`
  - `--enable-libxvid (GPL-2.0-or-later)`
  - `--enable-librubberband (GPL-2.0-or-later)`
  - `--enable-libvidstab (GPL-2.0-or-later)`
- **Notes:**
  - NOT the stock LGPL FFmpeg. --enable-gpl plus --enable-version3 makes the whole binary GPL-3.0-or-later. x264, x265, Xvid, Rubber Band and vid.stab are each independently GPL and each on their own force --enable-gpl.
  - Invoked only as a separate child process (child_process.spawn / execFile); there is no linking of any kind against the application code.

<details><summary>Full build configuration, read from the shipped binary</summary>

```
--enable-gpl --enable-version3 --enable-static --pkg-config=pkgconf --disable-w32threads --disable-autodetect --enable-fontconfig --enable-iconv --enable-gnutls --enable-libxml2 --enable-gmp --enable-bzlib --enable-lzma --enable-zlib --enable-libsrt --enable-libssh --enable-libzmq --enable-avisynth --enable-sdl2 --enable-libwebp --enable-libx264 --enable-libx265 --enable-libxvid --enable-libaom --enable-libopenjpeg --enable-libvpx --enable-mediafoundation --enable-libass --enable-libfreetype --enable-libfribidi --enable-libharfbuzz --enable-libvidstab --enable-libvmaf --enable-libzimg --enable-amf --enable-cuda-llvm --enable-cuvid --enable-ffnvcodec --enable-nvdec --enable-nvenc --enable-dxva2 --enable-d3d11va --enable-libvpl --enable-libgme --enable-libopenmpt --enable-libopencore-amrwb --enable-libmp3lame --enable-libtheora --enable-libvo-amrwbenc --enable-libgsm --enable-libopencore-amrnb --enable-libopus --enable-libspeex --enable-libvorbis --enable-librubberband
```

</details>

#### FFmpeg (bundled CLI) 6.1.1-tessus

- **License:** `GPL-3.0-or-later`
- **Supplier:** Tessus (evermeet.cx), via ffmpeg-static 5.3.0 (release tag b6.1.1)
- **Ships on:** darwin-x64
- **Linkage:** separate-process
- **Modified by us:** no
- **What makes it copyleft:**
  - `--enable-gpl`
  - `--enable-version3`
  - `--enable-libx264 (GPL-2.0-or-later)`
  - `--enable-libx265 (GPL-2.0-or-later)`
  - `--enable-libxvid (GPL-2.0-or-later)`
  - `--enable-librubberband (GPL-2.0-or-later)`
  - `--enable-libvidstab (GPL-2.0-or-later)`
  - `--enable-libxavs (GPL-2.0-or-later)`
- **Notes:**
  - GPL-3.0-or-later, same analysis as the Windows build.
  - Separate process only.

<details><summary>Full build configuration, read from the shipped binary</summary>

```
--cc=/usr/bin/clang --prefix=/opt/ffmpeg --extra-version=tessus --enable-avisynth --enable-fontconfig --enable-gpl --enable-libaom --enable-libass --enable-libbluray --enable-libdav1d --enable-libfreetype --enable-libgsm --enable-libmodplug --enable-libmp3lame --enable-libmysofa --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvmaf --enable-libvo-amrwbenc --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx264 --enable-libx265 --enable-libxavs --enable-libxml2 --enable-libxvid --enable-libzimg --enable-libzmq --enable-libzvbi --enable-version3 --pkg-config-flags=--static --disable-ffplay
```

</details>

#### FFmpeg (bundled CLI) 6.0 (libavcodec 60.3.100) — BLOCKING

- **License:** `GPL-3.0-or-later AND NONFREE-UNDISTRIBUTABLE`
- **Supplier:** third-party macOS arm64 build, via ffmpeg-static 5.3.0 (release tag b6.1.1)
- **Ships on:** darwin-arm64
- **Linkage:** separate-process
- **Modified by us:** no
- **What makes it copyleft:**
  - `--enable-nonfree (REDISTRIBUTION PROHIBITED)`
  - `--enable-gpl`
  - `--enable-version3`
  - `--enable-libx264 (GPL-2.0-or-later)`
  - `--enable-libx265 (GPL-2.0-or-later)`
  - `--enable-libvidstab (GPL-2.0-or-later)`
- **Notes:**
  - HIGHEST-SEVERITY FINDING.
  - This build carries --enable-nonfree.
  - FFmpeg's own position is that a --enable-nonfree build combines GPL code with terms incompatible with the GPL, and the resulting binary is UNREDISTRIBUTABLE - not merely copyleft-encumbered.
  - It cannot be shipped under any licence, including GPL.
  - This is the binary the macOS CI job downloads, because macos-latest is an arm64 runner and ffmpeg-static resolves the binary by host arch at `npm install` time.
  - Both the arm64 AND the x64 macOS DMG therefore carry this same arm64 nonfree binary - which is also a functional bug: it will not execute at all on an Intel Mac.
  - Fix is a build change, not a code change - see the audit memo.

<details><summary>Full build configuration, read from the shipped binary</summary>

```
--prefix=/Volumes/tempdisk/sw --extra-cflags=-fno-stack-check --arch=arm64 --cc=/usr/bin/clang --enable-gpl --enable-libvmaf --enable-libbluray --enable-libopenjpeg --enable-libopus --enable-libmp3lame --enable-libx264 --enable-libx265 --enable-libvpx --enable-libwebp --enable-libass --enable-libfreetype --enable-fontconfig --enable-libtheora --enable-libvorbis --enable-libsnappy --enable-libaom --enable-libvidstab --enable-libzimg --enable-libsvtav1 --enable-libkvazaar --enable-version3 --pkg-config-flags=--static --enable-ffplay --enable-postproc --enable-nonfree --enable-neon --enable-runtime-cpudetect --disable-indev=qtkit --disable-indev=x11grab_xcb
```

</details>

#### FFmpeg (bundled CLI) 7.0.2-static

- **License:** `GPL-3.0-or-later`
- **Supplier:** John Van Sickle, via ffmpeg-static 5.3.0 (release tag b6.1.1)
- **Ships on:** linux-x64
- **Linkage:** separate-process
- **Modified by us:** no
- **What makes it copyleft:**
  - `--enable-gpl`
  - `--enable-version3`
  - `--enable-frei0r (GPL-2.0-or-later)`
  - `--enable-libx264 (GPL-2.0-or-later)`
  - `--enable-libx265 (GPL-2.0-or-later)`
  - `--enable-libxvid (GPL-2.0-or-later)`
  - `--enable-librubberband (GPL-2.0-or-later)`
  - `--enable-libvidstab (GPL-2.0-or-later)`
- **Notes:**
  - Linux AppImage / deb only.
  - The build's own README states plainly: 'This static build is licensed under the GNU General Public License version 3.' Ships only if the Linux targets are released; CI currently builds Windows and macOS only.

<details><summary>Full build configuration, read from the shipped binary</summary>

```
--enable-gpl --enable-version3 --enable-static --disable-debug --disable-ffplay --disable-indev=sndio --disable-outdev=sndio --cc=gcc --enable-fontconfig --enable-frei0r --enable-gnutls --enable-gmp --enable-libgme --enable-gray --enable-libaom --enable-libfribidi --enable-libass --enable-libvmaf --enable-libfreetype --enable-libmp3lame --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenjpeg --enable-librubberband --enable-libsoxr --enable-libspeex --enable-libsrt --enable-libvorbis --enable-libopus --enable-libtheora --enable-libvidstab --enable-libvo-amrwbenc --enable-libvpx --enable-libwebp --enable-libx264 --enable-libx265 --enable-libxml2 --enable-libdav1d --enable-libxvid --enable-libzvbi --enable-libzimg
```

</details>

#### ffprobe (bundled CLI) 4.0.2 (libavcodec 58.18.100)

- **License:** `GPL-3.0-or-later`
- **Supplier:** ffprobe-static 3.1.0 (vendored binaries)
- **Ships on:** win32-x64, win32-ia32, linux-x64, linux-ia32, darwin-x64
- **Linkage:** separate-process
- **Modified by us:** no
- **Package manager reports:** `MIT` — **actual: `GPL-3.0-or-later`**
  - ffprobe-static's package.json declares MIT.
  - That MIT covers roughly 20 lines of JavaScript that resolve a path.
  - The binaries it vendors are --enable-gpl --enable-version3 FFmpeg builds.
  - Any tool that reads only package metadata - npm sbom, license-checker, most SCA scanners - will report this component as MIT and miss a GPL obligation entirely.
  - This is exactly why this file exists.
- **What makes it copyleft:**
  - `--enable-gpl`
  - `--enable-version3`
  - `--enable-libx264 (GPL-2.0-or-later)`
  - `--enable-libx265 (GPL-2.0-or-later)`
- **Notes:**
  - ffprobe-static vendors binaries for all platforms in the package; package.json build.files prunes the non-target platforms per build.

<details><summary>Full build configuration, read from the shipped binary</summary>

```
--enable-gpl --enable-version3 --enable-static --enable-libx264 --enable-libx265 --enable-libxvid --enable-librubberband --enable-frei0r (full string varies per platform; see generator evidence)
```

</details>

#### ffprobe (bundled CLI) 4.4 (libavcodec 58.134.100), Tessus build

- **License:** `GPL-3.0-or-later`
- **Supplier:** ffprobe-static 3.1.0 (vendored binaries)
- **Ships on:** darwin-arm64
- **Linkage:** separate-process
- **Modified by us:** no
- **What makes it copyleft:**
  - `--enable-gpl`
  - `--enable-version3`
  - `--enable-libx264 (GPL-2.0-or-later)`
  - `--enable-libx265 (GPL-2.0-or-later)`
  - `--enable-libxvid (GPL-2.0-or-later)`
  - `--enable-libxavs (GPL-2.0-or-later)`
- **Notes:**
  - Filed under bin/darwin/arm64 but the Mach-O header says x86_64 - it is NOT an arm64 binary.
  - On Apple Silicon it runs under Rosetta 2, and fails outright if Rosetta is not installed.
  - Functional bug, flagged here because it changes which binary actually reaches a customer machine.

<details><summary>Full build configuration, read from the shipped binary</summary>

```
--cc=/usr/bin/clang --prefix=/opt/ffmpeg --extra-version=tessus --enable-avisynth --enable-fontconfig --enable-gpl --enable-libaom --enable-libass --enable-libbluray --enable-libdav1d --enable-libfreetype --enable-libgsm --enable-libmodplug --enable-libmp3lame --enable-libmysofa --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopus --enable-librubberband --enable-libshine --enable-libsnappy --enable-libsoxr --enable-libspeex --enable-libtheora --enable-libtwolame --enable-libvidstab --enable-libvmaf --enable-libvo-amrwbenc --enable-libvorbis --enable-libvpx --enable-libwebp --enable-libx264 --enable-libx265 --enable-libxavs --enable-libxvid --enable-libzimg --enable-libzmq --enable-libzvbi --enable-version3 --pkg-config-flags=--static --disable-ffplay
```

</details>

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
| FFmpeg (bundled CLI) | 6.1.1-essentials_build-www.gyan.dev | `GPL-3.0-or-later` | separate-process | no | win32-x64 |
| FFmpeg (bundled CLI) | 6.1.1-tessus | `GPL-3.0-or-later` | separate-process | no | darwin-x64 |
| FFmpeg (bundled CLI) | 6.0 (libavcodec 60.3.100) | `GPL-3.0-or-later AND NONFREE-UNDISTRIBUTABLE` | separate-process | no | darwin-arm64 |
| FFmpeg (bundled CLI) | 7.0.2-static | `GPL-3.0-or-later` | separate-process | no | linux-x64 |
| ffprobe (bundled CLI) | 4.0.2 (libavcodec 58.18.100) | `GPL-3.0-or-later` | separate-process | no | win32-x64<br>win32-ia32<br>linux-x64<br>linux-ia32<br>darwin-x64 |
| ffprobe (bundled CLI) | 4.4 (libavcodec 58.134.100), Tessus build | `GPL-3.0-or-later` | separate-process | no | darwin-arm64 |

---

## npm packages (production tree)

All 39 packages below are pure JavaScript, loaded via
`require()` into the Electron main process. None is a compiled native extension,
and none has been modified. Development dependencies are excluded: electron-builder
prunes them, so they never reach a customer machine.

| Package | Version | License | Class |
|---|---|---|---|
| `@derhuerst/http-basic` | 8.2.4 | `MIT` | permissive |
| `@types/node` | 10.17.60 | `MIT` | permissive |
| `agent-base` | 6.0.2 | `MIT` | permissive |
| `argparse` | 2.0.1 | `Python-2.0` | permissive |
| `async` | 0.2.10 | `MIT` | permissive |
| `buffer-from` | 1.1.2 | `MIT` | permissive |
| `builder-util-runtime` | 9.7.0 | `MIT` | permissive |
| `caseless` | 0.12.0 | `Apache-2.0` | permissive |
| `concat-stream` | 2.0.0 | `MIT` | permissive |
| `debug` | 4.4.3 | `MIT` | permissive |
| `electron-updater` | 6.8.9 | `MIT` | permissive |
| `env-paths` | 2.2.1 | `MIT` | permissive |
| `ffmpeg-static` | 5.3.0 | `GPL-3.0-or-later` | strong-copyleft |
| `ffprobe-static` | 3.1.0 | `MIT` | permissive |
| `fluent-ffmpeg` | 2.1.3 | `MIT` | permissive |
| `fs-extra` | 10.1.0 | `MIT` | permissive |
| `graceful-fs` | 4.2.11 | `ISC` | permissive |
| `http-response-object` | 3.0.2 | `MIT` | permissive |
| `https-proxy-agent` | 5.0.1 | `MIT` | permissive |
| `inherits` | 2.0.4 | `ISC` | permissive |
| `isexe` | 2.0.0 | `ISC` | permissive |
| `js-yaml` | 4.3.1 | `MIT` | permissive |
| `jsonfile` | 6.2.1 | `MIT` | permissive |
| `lazy-val` | 1.0.5 | `MIT` | permissive |
| `lodash.escaperegexp` | 4.1.2 | `MIT` | permissive |
| `lodash.isequal` | 4.5.0 | `MIT` | permissive |
| `ms` | 2.1.3 | `MIT` | permissive |
| `parse-cache-control` | 1.0.1 | `BSD-3-Clause` | permissive |
| `progress` | 2.0.3 | `MIT` | permissive |
| `readable-stream` | 3.6.2 | `MIT` | permissive |
| `safe-buffer` | 5.2.1 | `MIT` | permissive |
| `sax` | 1.6.1 | `BlueOak-1.0.0` | permissive |
| `semver` | 7.7.4 | `ISC` | permissive |
| `string_decoder` | 1.3.0 | `MIT` | permissive |
| `tiny-typed-emitter` | 2.1.0 | `MIT` | permissive |
| `typedarray` | 0.0.6 | `MIT` | permissive |
| `universalify` | 2.0.1 | `MIT` | permissive |
| `util-deprecate` | 1.0.2 | `MIT` | permissive |
| `which` | 1.3.1 | `ISC` | permissive |

### Licenses resolved by hand

npm publishes no license field for these. Each was read off the `LICENSE` file in
the installed package rather than assumed.

- **`async@0.2.10` → `MIT`** — node_modules/fluent-ffmpeg/node_modules/async/LICENSE — "Copyright (c) 2010 Caolan McMahon", verbatim MIT text
- **`parse-cache-control@1.0.1` → `BSD-3-Clause`** — node_modules/parse-cache-control/LICENSE — "Copyright (c) 2012-2014, Walmart", 3-clause BSD incl. no-endorsement clause

---

## Method

- npm packages come from `package-lock.json`, production tree only.
- Native binary licenses were **not** taken from package metadata. Each was read
  out of the shipped binary itself with `strings -a <binary> | grep -- --enable-`,
  because FFmpeg compiles its `configure` line into the executable. That string is
  the authoritative record of what a given build actually contains.
- Re-run the binary check at any time with `npm run oss:verify`.
- Machine-readable equivalent: `docs/oss/pokitplayer.cdx.json` (CycloneDX 1.5).

