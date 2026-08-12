# PokitPlayer — Pinned Work

**Owner:** Maiden Media Solutions INC.
**Source spec:** `PRO_PLAYBACK_FEATURE_SPEC.md`
**Pinned:** 2026-08-11

Everything in the feature spec that was **not** built in the 2026-08-11 pass, why it was
deferred, and what it actually takes to finish. Each item lists the real blocker, not just
the effort. Sections that shipped are listed at the bottom for reference.

---

## §1 — IMF / DCP Playback

**Why pinned:** This is a composition engine, not a codec problem. Nothing in the current
architecture models "one timeline assembled from many essence files."

**What it takes:**
1. CPL XML parser (SMPTE ST 2067 for IMF, SMPTE/Interop for DCP) — resolve
   `SegmentList → SequenceList → ResourceList`, and map UUIDs to physical track files
   through the ASSETMAP and PKL.
2. An in-memory edit list: ordered `{assetPath, entryPoint, duration, editRate}` across
   video, audio and timed-text virtual tracks.
3. A playback path that switches essence files at resource boundaries without a visible
   seam, and a scrubber that presents the composition as one continuous timeline while
   internally seeking across files.
4. JPEG 2000 in MXF decode for DCP. **Performance risk:** `libopenjpeg` is not fast; 2K/4K
   J2K may not hit realtime on a typical workstation. Prove decode throughput on a real
   DCP before committing to the UI work.
5. Encrypted DCP (KDM) is explicitly out of scope for a first pass — detect and report
   "encrypted, KDM required" instead.

**Estimate:** multi-week. The seam-free segment switching is the hard part, not the XML.

---

## §3 (partial) — CEA-708 Decoding

**Shipped:** CEA-608, both as SCC sidecars and extracted from embedded streams.

**Why pinned:** The bundled FFmpeg has exactly one caption decoder — `cc_dec`
(`Closed Caption (EIA-608 / CEA-708)`), which decodes the 608 compatibility bytes. There
is no 708 window/pen/service model in it, and `ccextractor` is not bundled.

**What it takes:** a real 708 decoder — service selection (services 1–63), the window and
pen state machine, the command set, and full Unicode character handling. Then a caption
service selector in the UI (CC1–CC4, 708 services, DVB PIDs).

**Estimate:** the single hardest item in the spec. Budget it alone.

**Cheaper alternative worth pricing first:** bundle `ccextractor` as a sidecar binary and
shell out to it, the same way we shell out to ffmpeg. Trades binary size and a license
review for most of the work.

---

## §7 — Compare Alternate Media (up to 16 sources)

**Why pinned:** Needs N independent decoders on one synchronized transport clock. The
current architecture assumes a single video element and a single stream decoder.

**What it takes:**
1. Refactor playback state so decoders are instances rather than module-level singletons.
   *This refactor is a prerequisite and is worth doing before anyone starts §7 proper.*
2. Full View (switch source), Split View (draggable wipe divider), Difference View
   (render both to canvas/WebGL and subtract, or `blend=difference`) with an
   amplification slider.
3. Timecode-based alignment and scaling to a common comparison canvas for sources of
   differing resolution and frame rate.

**Estimate:** multi-week, and gated on the decoder-instancing refactor.

---

## §9 — External Monitor Preview (SDI/HDMI via AJA / Blackmagic)

**Why pinned:** Requires vendor SDKs and physical hardware. **Cannot be validated at all
without a card in the machine** — no amount of careful coding substitutes for testing
against real hardware.

**What it takes:**
1. An Electron native addon (N-API) — this is C++, not JS.
2. Blackmagic DeckLink SDK, and the AJA SDK for Kona LHi / Kona 4 / Kona 3G / T-TAP /
   Io 4K / Io XT. Review both licenses before starting.
3. Genlocked frame + audio output, device/format selection in Preferences.
4. VANC parsing and overlay on the external output.
5. Clean degradation when no device is present.

**Estimate:** its own milestone. Do not start it inside another feature's timeline.

---

## §10 — DPP / AS-11 QC

**Why pinned:** ffprobe surfaces MXF *container* metadata, but not the AS-11 descriptive
metadata sets. Those need the MXF header parsed directly — KLV triplets and the UK DPP
shim's structural metadata.

**What it takes:**
1. A KLV/MXF header parser (partition packs, primer pack, metadata sets).
2. Decode the AS-11 UK DPP shim: programme title, series/episode, aspect-ratio flags,
   audio track layout, line-up and loudness, closed-caption flags, etc.
3. A dedicated "DPP / AS-11" inspector tab, with validation of mandatory fields and
   violations surfaced.
4. AS-02 versioned masters as a follow-on.

**Estimate:** the MXF header parser is the bulk of it and is reusable for §1.

**Note:** the loudness half of AS-11 compliance is already covered — §6 shipped with EBU
R128 pass/fail.

---

## §11 / §12 — Edit Mode, Export/Rewrap, Audio Editing, Apple Packages

**Why pinned:** Not architecturally blocked — `transcoder.js` already drives fluent-ffmpeg
and could take an export dialog. Pinned purely as scope. This is the most tractable of the
pinned items and is the natural next thing to build.

**What it takes:**
- **Export dialog** — container/codec targets, trim (frame-accurate in/out), scale, crop.
- **Rewrap** — stream-copy (`-c copy`) into a new container; audio-only export.
- **Audio editing** — split/join/rearrange tracks and reassign speakers via `-map`,
  `amerge`, `pan`, `channelmap`; resample with `aresample`; downmix (8→2) via `pan`
  matrices.
- **Apple `.itmsp` packages** — directory structure, media + sidecars + chapters + package
  XML per the Apple asset spec, ITT for captions.

### Two spec corrections to carry into this work

Both were verified against the bundled FFmpeg 6.1.1 build on 2026-08-11:

1. **ProRes export is NOT macOS-only.** The spec says it is. `prores_ks`, `prores_aw` and
   `prores` encoders are all present in the Windows build. ProRes export works on Windows.
2. **"Export to Windows Media" is narrower than the spec implies.** The only WM encoders
   present are `wmv2` (Windows Media Video 8) and `wmav2`. There is no `wmv3`/VC-1
   encoder. Either scope the feature to WMV8 or replace the FFmpeg binary with a build
   that includes a VC-1 encoder.

---

## Cross-cutting debt

### ffprobe version mismatch — affects §4 acceptance criteria

`ffprobe-static` ships **4.0.2 (2018)** while the bundled ffmpeg is **6.1.1**. Consequences:

- No Dolby Vision RPU / configuration-record reporting.
- No HDR10+ dynamic metadata (SMPTE ST 2094).
- Newer codec profile reporting is missing or less precise.

HDR10 static metadata (mastering display, MaxCLL/MaxFALL) **does** work — it is read from
first-frame side data.

**Fix:** ship an ffprobe 6.x binary in `src/bin/` alongside the platform ffmpeg. The
resolution logic in `inspector.js#getFfprobePath` already prefers `src/bin` over the npm
package, so this is a packaging change, not a code change.

### Installer size

Bundling ffprobe adds roughly **63MB** per platform. Unpacked Windows build is about
**407MB**; expect the installer near **160MB**, up from **100MB**.

### Code signing

**Windows** builds are unsigned — `no signing info identified, signing is skipped`.
SmartScreen warns users on launch. Needs a certificate plus `CSC_LINK` /
`CSC_KEY_PASSWORD`.

**macOS** signing is wired into CI but needs these repository secrets before it does
anything:

| Secret | What it is |
|---|---|
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` |
| `MAC_CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID email |
| `APPLE_ID_PASSWORD` | App-specific password, **not** the account password |
| `APPLE_TEAM_ID` | 10-character Team ID |

Until they exist the macOS job builds unsigned and says so in the log.

**Trap to know about before enabling notarization:** `build.mac.signIgnore` in
`package.json` excludes `src/bin/ffmpeg-darwin` and `src/bin/ffmpeg-darwin-arm64` from
signing. Under hardened runtime, *every* Mach-O in the bundle must be signed or
notarization fails. Those files don't currently exist (`src/bin` holds only a README, and
the real binaries come from the `ffmpeg-static` / `ffprobe-static` packages, which
electron-builder does sign). But the moment someone drops a platform binary into
`src/bin`, notarization will start failing with a non-obvious error. Remove `signIgnore`
when the certificate is added.

### latest.yml filename mismatch

The auto-update manifest names `PokitPlayer-Setup-<version>.exe` (hyphens) while the built
artifact is `PokitPlayer Setup <version>.exe` (spaces). Upload the file under the
hyphenated name or auto-update 404s. Pre-existing, unrelated to this work.

### Electron 28

End of life. Worth scheduling an upgrade for the security fixes.

---

## Shipped 2026-08-11

| Spec | Status |
|---|---|
| §2 Broad professional format playback | Containers and codecs verified against generated test files |
| §3 Captions — sidecar + embedded 608 | SRT, WebVTT, SCC, TTML/IMSC1/iTT/DFXP, EBU STL; 708 pinned above |
| §4 Media Inspector | Full ffprobe-driven inspector incl. clean aperture, speaker labels, HDR |
| §5 Secondary files (sync check) | Secondary audio + caption, shared frame-accurate offset |
| §6 Audio meters & loudness | Per-channel meters w/ solo/mute; BS.1770 gated & ungated, R128 + A/85 pass/fail |
| §8 Timeline / GOP structure | I/P/B strip + per-frame data-rate curve, click-to-seek |

Also fixed in this pass: J/K/L shuttle now follows the Premiere notch ladder, Space no
longer double-fires against menu accelerators, and frame rate is corrected from ffprobe
(GXF was reporting the 50 Hz field rate as 50 fps, which doubled every timecode).
