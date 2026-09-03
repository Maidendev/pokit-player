# PokitPlayer — Open-Source Licence Audit and Remediation (Player Binary)

**Product:** PokitPlayer 1.2.7 (Electron desktop application)
**Owner:** Maiden Media Solutions INC.
**Audited:** 2026-09-03 · **Remediated:** 2026-09-03
**Scope:** the distributed player binary only — Windows NSIS/portable, macOS DMG/ZIP,
Linux AppImage/deb.
**Companion files:**
`PLAYER-COMPONENTS.md` (generated inventory) · `pokitplayer.cdx.json` (CycloneDX SBOM)

Engineering findings prepared for counsel. It states what was in the build, what was
changed, and what still needs a human decision. It offers no legal conclusion.

---

## 1. Position

**Before:** one binary that could not lawfully be redistributed at all, and six
GPL-3 components, in every shipped installer.

**Now:** no GPL, no non-distributable component anywhere in the player. The
copyleft surface is LGPL only, satisfied by an architecture the app already had.

| | Before | After |
|---|---|---|
| Components shipped to customers | 49 | 25 |
| Non-distributable | 1 | **0** |
| Strong copyleft (GPL/AGPL/SSPL) | 6 | **0** |
| Weak copyleft (LGPL) | 1 | 4 |
| Undetermined licence | 0 | 0 |
| Modified by us | 0 | 0 |

`npm run oss:check` exits 0. It exited 1 before.

---

## 2. What was wrong

### The blocking finding

The macOS FFmpeg binary was built `--enable-nonfree`. FFmpeg's own position is
that such a build combines GPL code with terms incompatible with the GPL, making
the result **not redistributable under any licence**, GPL included. It was in the
shipped Mac app.

Nobody chose it. `ffmpeg-static` downloads a community build at `npm install`
time selected by *host architecture*, so CI's arm64 runner fetched an arm64
binary — which electron-builder then packaged into **both** the arm64 and the x64
DMG. The Intel build therefore shipped an executable that could not run on an
Intel Mac, and both shipped the non-distributable one.

### The GPL finding

Every bundled `ffmpeg` and `ffprobe`, on every platform, was **GPL-3.0-or-later**:

```
--enable-gpl --enable-version3 --enable-libx264 --enable-libx265
```

`--enable-gpl` relicenses the binary from LGPL to GPL. `--enable-version3` moves
it to GPL-**3**, which carries terms a GPL-2 analysis would miss. Removing the
flag alone would not have helped: x264, x265, Xvid, Rubber Band, vid.stab and
frei0r are each independently GPL and each force `--enable-gpl`.

### The finding that would have been missed

`ffprobe-static` declares **MIT** to npm while vendoring GPL-3 FFmpeg builds.
That MIT covers about twenty lines of path-resolving JavaScript. `npm sbom`,
`license-checker` and most SCA scanners read package metadata and would have
reported this component clean. A package-manager-only audit would have concluded
the build was fine.

---

## 3. What changed

### Binaries: GPL → LGPL, and pinned

| Platform | Before | After |
|---|---|---|
| Windows x64 | FFmpeg 6.1.1 gyan.dev, **GPL-3** | BtbN LGPL build, **LGPL-3.0-or-later** |
| Linux x64 | FFmpeg 7.0.2 J. Van Sickle, **GPL-3** | BtbN LGPL build, **LGPL-3.0-or-later** |
| macOS x64 | FFmpeg 6.1.1 Tessus, **GPL-3** | built from source, **LGPL-2.1-or-later** |
| macOS arm64 | FFmpeg 6.0, **GPL-3 + nonfree** | built from source, **LGPL-2.1-or-later** |
| ffprobe (all) | FFmpeg 4.0.2 / 4.4, **GPL-3** | same build as ffmpeg, **LGPL** |

macOS is compiled rather than downloaded because no reputable source publishes an
LGPL macOS build — Homebrew, evermeet.cx and osxexperts all ship `--enable-gpl`.
The configure line is ours, passes no `--enable-gpl`, and links no external
library at all; encoding uses VideoToolbox, an Apple OS framework. It is
marginally *more* permissive than the other two platforms (LGPL-2.1 rather than
LGPL-3) because nothing in it requires version3. Accurate rather than uniform.

`ffmpeg-static` and `ffprobe-static` are gone. Binaries now come from
`scripts/fetch-ffmpeg.js` with a pinned URL and SHA-256, or from
`scripts/build-ffmpeg-macos.sh` with pinned source. Path resolution no longer has
an npm fallback at all: a binary we did not fetch is a binary whose licence we
have not verified, and that is exactly how the bad ones arrived.

### The encoder swap

This was the real work, and the reason it was not a configuration change. The
playback pipeline transcoded with **libx264**, which is GPL and is what forced
`--enable-gpl` in the first place. Removing x264 meant replacing the encoder.

`src/encoder.js` now selects one at runtime. Presence in `ffmpeg -encoders` is
not sufficient — a binary built with nvenc still lists `h264_nvenc` on a machine
with no NVIDIA card — so each candidate is confirmed with a one-frame test encode
before it is chosen. That turns a mid-playback failure into a startup decision.

| Encoder | Licence | Used on |
|---|---|---|
| `h264_videotoolbox` | Apple OS framework | macOS |
| `h264_nvenc` / `h264_qsv` / `h264_amf` | LGPL headers / MIT SDKs | Windows, Linux |
| `libopenh264` | BSD-2-Clause | software fallback |
| `libvpx-vp9` | BSD-3-Clause | last resort |

The MSE codec string the renderer declares now comes from the main process
(`get-mse-codec`) rather than being hardcoded, so the encoder and the codec
string cannot drift apart — VP9 needs `vp09.00.41.08` where H.264 needs
`avc1.640029`. `src/encoder.js` also refuses to invoke x264/x265 even if a GPL
binary is ever substituted: the gate below is the real control, this is the
second lock.

### The gate

`scripts/verify-ffmpeg-license.js` reads the configure line compiled into each
shipped binary and fails on `--enable-gpl`, `--enable-nonfree`, or any GPL-only
library. It runs on `prebuild`, after every fetch, after the macOS build, and in
CI before packaging.

This is what the position now rests on. Pinned URLs and checksums say where a
binary came from; only this says what is in it. Both directions were tested: it
passes the new LGPL binaries and **fails the exact binaries that used to ship**,
naming `--enable-nonfree` on the macOS one.

### Also fixed, because the same change touched them

- **macOS architecture bug.** CI built both Mac DMGs on one arm64 runner. Now
  `macos-14` builds arm64 and `macos-13` builds x64, natively. The generic
  `ffmpeg-darwin` filename that allowed the mix-up is gone.
- **`signIgnore` notarisation trap.** `PINNED.md` warned that the moment a real
  binary landed in `src/bin`, hardened-runtime notarisation would start failing
  with a non-obvious error. Binaries now always live there, so `signIgnore` is
  removed and electron-builder signs them.
- **ffprobe version mismatch.** `PINNED.md` recorded ffprobe 4.0.2 (2018) against
  ffmpeg 6.1.1. One archive now supplies both, so they match by construction. The
  Dolby Vision / HDR10+ reporting gaps that mismatch caused should be re-tested.
- **`fluent-ffmpeg` removed.** Declared as a dependency, shipped to customer
  machines, and imported by nothing. Its removal also drops `async@0.2.10` and
  `which` from the shipped tree. The production tree went from 39 packages to 14.
  (`PINNED.md` claimed `transcoder.js` drives fluent-ffmpeg; it never did — it
  spawns ffmpeg directly. Corrected there.)
- **About dialog.** Said "Built with Electron + ffmpeg. MIT License", which was
  inaccurate. Now states the LGPL position and points at the component list.
- **Setup docs.** `src/bin/README.md` and `REPLIT_SETUP.md` told people to
  download from evermeet.cx and gyan.dev — both GPL. That is how this happens.
  Replaced with the scripted path and an explanation of why.

---

## 4. What was verified, and what was not

Being explicit, because the difference matters for release planning.

### Verified here

- **Licence gate, both directions.** Passes the new LGPL binaries; fails the old
  GPL and `--enable-nonfree` ones, naming the flags.
- **Windows and Linux LGPL builds.** Downloaded and inspected. No `--enable-gpl`,
  no `--enable-nonfree`, with x264/x265/Xvid/Rubber Band/vid.stab/frei0r
  explicitly disabled.
- **The playback pipeline, end to end.** The exact argv the real `StreamDecoder`
  builds was captured and run against a 1080p ProRes 422 HQ source. Output is
  H.264 High, `yuv420p`, valid fragmented MP4 (6 `moof` boxes plus `moov`) —
  the shape MSE requires. VP9 fallback and both quality-mode paths also produce
  valid output.
- **Encoder selection logic.** On this machine it correctly rejected `h264_nvenc`
  and `h264_qsv` — compiled in, no usable hardware — and landed on `libopenh264`.
- **Application boot.** Starts under Xvfb, resolves `src/bin/ffmpeg` and
  `src/bin/ffprobe`, runs without error.
- **Dependency position.** `npm run oss:check` exits 0.

### Not verified here — needs real hardware

- **The macOS build script has never been run.** This container is Linux, and
  FFmpeg source archives are unreachable from it. The script is written and its
  shell syntax checked, but it is unexercised. **Run it on both a `macos-13` and
  a `macos-14` runner before trusting the Mac builds.** It will also fail on
  first run by design, because `source.sha256` in `scripts/ffmpeg-sources.json`
  is deliberately `null` — the script prints the computed hash and stops rather
  than trusting a first download. Verify that hash against ffmpeg.org's published
  checksum, record it, re-run.
- **Hardware encoder paths.** `h264_videotoolbox`, `h264_nvenc`, `h264_qsv` and
  `h264_amf` are unexercised — no GPU here. The runtime test-encode should make a
  bad pick fail safely into the software path, but that is a designed behaviour,
  not an observed one.
- **Playback in the actual player.** The pipeline was validated at the ffmpeg
  level. Nobody has watched a frame. Run the format matrix — ProRes variants,
  DNxHD/HR, MXF, image sequences — on Windows and macOS.
- **Performance.** On this machine, software `libopenh264` ran 1080p ProRes HQ at
  **2.4× realtime**, so the software floor looks adequate. But OpenH264 is slower
  than x264 ultrafast was. On a GPU-equipped machine the hardware path should be
  *faster* than before; on a GPU-less machine encoding 4K, it may be slower. Worth
  measuring on a real workstation with real media.

---

## 5. Residual items

1. **Checksum drift, by design.** BtbN publishes LGPL variants only as
   master-branch snapshots under a rolling `latest` tag — there is no
   release-branch LGPL asset. The exact SHA-256 is pinned, so the artefact cannot
   change silently, but the pin *will* eventually stop matching when upstream
   rebuilds. The fetch fails closed and says how to re-pin. For fully
   reproducible builds, mirror the artefacts to storage we control and set
   `FFMPEG_MIRROR_BASE`.

2. **Building all three platforms from source** would remove both the
   master-snapshot question and any reliance on a third party's build, as macOS
   already does. Windows needs MSYS2 in CI, which is why it was not done now.
   Worth doing before diligence if the reviewer is thorough.

3. **H.264 / AAC / HEVC patents** remain a live consideration — Via LA, Access
   Advance — and are **entirely separate from open-source licensing**. Nothing in
   this work touches them. One nuance now relevant: Cisco's well-known H.264
   royalty offer covers *Cisco's own precompiled* OpenH264 binary; a libopenh264
   compiled by someone else does not automatically inherit that coverage.

4. **Electron 28 is end-of-life** (`PINNED.md`). A security matter, not a
   licensing one, but it is the oldest thing in the build.

5. **`npm run lint` is broken** — ESLint 10 requires `eslint.config.js` and the
   repo has no ESLint config at all. Pre-existing, unrelated to this work, and
   worth fixing since it means nothing is being linted.

---

## 6. The rest of the stack

Still unanswerable from this repository: `pokit-player` contains no server code,
no model artefacts and no training pipeline. Reporting it clean would be
misleading rather than reassuring.

Point the same tooling at those repositories and the distinction counsel asked
for is already modelled in the schema:

- **`shipsToCustomer: true|false`** separates distributed code from server-only
  code. That is the AGPL/SSPL line, and the one that matters: those licences
  trigger on serving software over a network. Worth checking the usual suspects
  early — MongoDB, Elasticsearch, Redis (post-2024), Grafana, MinIO — several of
  which relicensed to SSPL or AGPL recently.
- **Model weights and training data** need their own manifest, not a code SBOM.
  Licence, provenance and commercial-use permission are per-model facts that live
  in model cards. This is the harder problem: a model fine-tuned on
  research-only weights can carry the restriction forward into the derived
  weights, which is far more painful to unwind than a library swap.

---

## 7. Reproducing this

```bash
npm install             # postinstall fetches the pinned LGPL binaries
npm run ffmpeg:verify   # licence gate — fails on any GPL or nonfree flag
npm run oss:check       # dependency gate — exits 1 on copyleft or unknown
npm run oss:inventory   # regenerate the inventory and CycloneDX SBOM
npm run oss:verify      # re-read every binary and print its build flags
```

Both gates run in CI before packaging. `oss:check` used to fail, correctly; it
now passes.
