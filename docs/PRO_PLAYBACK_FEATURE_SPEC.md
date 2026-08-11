# PokitPlayer — Professional Playback & QC Feature Spec

**Product:** PokitPlayer (PokitQC desktop player)
**Owner:** Maiden Media Solutions INC.
**Stack:** Electron 28, FFmpeg (`ffmpeg-static` + `fluent-ffmpeg`), custom `stream-decoder.js` / `transcoder.js`, `renderer.js` UI.

This is an implementation brief for VS Code. It describes the target feature set for turning PokitPlayer into a professional media-inspection and QC player. Each feature lists **what it does**, **how to build it on our current stack**, and **acceptance criteria**. Features are grouped so they can be shipped incrementally. Where a feature needs a native hardware SDK (AJA/Blackmagic), it is flagged as a native-addon effort.

Suggested tiering (optional, mirrors how pro players gate features): **Core** (all users), **Plus**, **Pro**. Treat tiers as feature flags; ship the capability first, gate later.

---

## 1. IMF / DCP Playback  — *Pro*

**What it does:** Load an IMF or DCP composition by pointing at its CPL (Composition Playlist). PokitPlayer resolves the CPL, maps the referenced assets, and plays the composition back as one seamless timeline — no manual stitching. Supports both simple and complex compositions (multiple segments, sequences, and reels).

**How to build it:**
- Parse the CPL XML (SMPTE ST 2067 for IMF; SMPTE DCP for D-Cinema). Read `EssenceDescriptor`, `SegmentList` → `SequenceList` → `ResourceList`, and resolve UUIDs to physical track files via the ASSETMAP / PKL.
- Build an in-memory edit list (ordered list of `{assetPath, entryPoint, duration, editRate}`) covering video, audio, and timed-text virtual tracks.
- Feed the edit list to FFmpeg as a concat/segment source (concat demuxer or programmatic segment switching in `stream-decoder.js`), honoring each resource's entry point and edit rate so cuts are frame-accurate.
- For DCP: handle JPEG 2000 in MXF essence and interop/SMPTE label sets. For encrypted DCP (KDM), scope as a later phase — decode only unencrypted assets initially and surface a clear "encrypted, KDM required" message.
- Present the composition as a single scrubber; internally seek across the resource boundaries.

**Acceptance criteria:**
- Loading a CPL plays the full composition end-to-end with no visible seams at reel/segment boundaries.
- Timecode is continuous and frame-accurate across segments.
- Multi-reel and multi-sequence CPLs resolve correctly; missing/unresolvable assets produce a specific error naming the missing UUID.

---

## 2. Broad Professional Format Playback  — *Core / Plus / Pro*

**What it does:** Frame-accurate playback of the container and codec formats professionals actually deliver.

**Coverage targets:**
- **Containers:** MXF (OP1a and OP-Atom), IMF, GXF, MPEG-2 Program Streams and Transport Streams, MOV, MP4, WMV, MKV, WebM, AVI.
- **Codecs:** H.264/AVC, HEVC/H.265 (incl. 4K), MPEG-2, Apple ProRes (422 / 422 HQ / 4444 / 4444 XQ), DNxHD / DNxHR, JPEG 2000, VC-1/WMV.
- Include the mezzanine/master formats we already support: ProRes, IMF, DNxHD/DNxHR, and JPEG 2000 in MXF.

**How to build it:**
- These are almost entirely covered by our bundled FFmpeg build. Audit the shipped `ffmpeg-static` binary with `ffmpeg -codecs` / `-formats` and confirm HEVC, JPEG 2000 (`libopenjpeg`), DNxHR, and MXF demux are present; if any are missing, swap to an FFmpeg build that includes them.
- Route non–browser-native codecs (ProRes, DNxHR, JPEG 2000, MXF-wrapped essence, GXF, MPEG-2 TS/PS, WMV) through the existing `stream-decoder.js` transcode-to-playable pipeline rather than the HTML5 `<video>` element.
- Snap detected frame rates to the standard set already handled (23.976, 24, 25, 29.97, 30, 50, 59.94, 60) and keep timecode frame-accurate for each.
- Gate the heavier codecs behind Plus/Pro if tiering: HEVC, 4K, DNxHD, JPEG 2000 → Plus/Pro.

**Acceptance criteria:**
- Each listed container/codec opens and plays with correct video, audio, and timecode.
- 4K HEVC plays without dropping to an error state on a typical workstation.
- Frame stepping is exact (no drift) on long-GOP MPEG-2/HEVC and on intra codecs (ProRes/DNxHR/J2K).

---

## 3. Caption & Subtitle Support  — *Plus / Pro*

**What it does:** Decode and render embedded captions and sidecar subtitle files across the formats delivery specs require, so a user can visually verify captions inside an MXF or Transport Stream.

**Coverage targets:**
- **Embedded captions:** CEA-608 and CEA-708 (including 708-only advanced features — Unicode character support, service selection), DVB subtitles, and captions carried in MXF and MPEG-2 TS.
- **Timed text / sidecar:** SCC, TTML (IMSC1, iTT, and SMPTE-TT), WebVTT, SRT, STL (EBU STL). Support SDH/CC/AD variants.

**How to build it:**
- For embedded 608/708, extract the caption data track via FFmpeg (`-f lavfi`/`ccextractor`-style extraction, or FFmpeg's `cc_dec`/`libzvbi`), decode to cue objects, and render as an overlay in `renderer.js`. CEA-708 needs a real 708 decoder (window/pen/service model + Unicode); budget this as the hardest sub-item.
- For sidecar files, parse each format to a common cue model `{startTC, endTC, text, style, region}` and render with the same overlay engine.
- Add a **caption service selector** (CC1–CC4, 708 services 1–63, DVB PIDs) and a caption-visibility toggle.
- Show a caption "presence" indicator in the inspector: which caption tracks/services exist in the file.

**Acceptance criteria:**
- 608 and 708 captions decode from an MXF and a TS file and render in sync with video.
- 708 Unicode glyphs render correctly (not mojibake or boxes).
- Each sidecar format loads and renders; malformed files produce a specific parse error, not a silent failure.

---

## 4. Media Inspector ("Check It")  — *Core, deeper in Plus / Pro*

**What it does:** Show all the relevant properties of a media file in a clean, well-organized panel — deep enough to be meaningful without drowning the user.

**Properties to surface:**
- **Video:** resolution, display/pixel aspect ratio, clean aperture, frame rate, scan type (interlaced/progressive + field order), bit depth, chroma subsampling, color primaries/transfer/matrix (HDR: Dolby Vision / HDR10 / HDR10+ / HLG metadata when present), codec + profile/level, bitrate, GOP hints.
- **Audio:** codec, channel count, channel/speaker labels (L/R/C/LFE/Ls/Rs…), sample rate, bit depth, per-track bitrate, loudness (see §6).
- **Container/metadata:** format, duration, timecode start, reel name, file size, modification date, and format-specific metadata (MXF descriptors, MOV/QuickTime atoms, MPEG TS PIDs/PMT).

**How to build it:**
- Drive this from `ffprobe -show_format -show_streams -show_frames -print_format json` plus a targeted MXF/MOV metadata read. Map the JSON into grouped sections in the existing file-info panel.
- Keep the current panel's "not too much" philosophy: default to a summarized view with an expandable "Advanced" section for the deep descriptors.

**Acceptance criteria:**
- Every property above is populated when present in the file and cleanly marked "—" when absent.
- Clean aperture, speaker labels, and color metadata specifically appear (these are the pro differentiators).
- Panel opens/toggles with the existing `⌘I` / `Ctrl+I` shortcut.

---

## 5. Secondary Files (Sync Check)  — *Plus / Pro*

**What it does:** Load a secondary audio file or a secondary caption/subtitle file alongside the primary media to check sync against the picture.

**How to build it:**
- Add a "Load secondary file" action that attaches an extra audio or timed-text source locked to the primary timeline's clock.
- For secondary audio, mix or switch monitoring to the secondary track; for secondary captions, render them in the overlay engine from §3.
- Provide a small **offset control** (± frames / ± ms) so the user can nudge and confirm alignment.

**Acceptance criteria:**
- A sidecar WAV plays in sync with the primary video and stays locked through seeks.
- A sidecar caption file renders against the primary picture; offset adjustments are reflected live.

---

## 6. Audio Meters & Loudness  — *Plus (meters) / Pro (loudness panel)*

**What it does:** Per-channel metering with solo/mute, true-peak and momentary loudness readouts, plus a loudness panel that computes program loudness to ITU-R BS.1770.

**How to build it:**
- Decode audio to PCM (Web Audio API on the already-decoded stream, or FFmpeg `ebur128`/`astats` filters) and render per-channel meters in `renderer.js`.
- **Meters (Plus):** per-channel level bars with solo/mute buttons, true-peak (dBTP, oversampled) and momentary loudness (M) values.
- **Loudness panel (Pro):** integrated/program loudness with **gated (BS.1770-3/-4)** and **ungated (BS.1770-2)** modes, plus loudness range (LRA) and max true peak. Provide preset targets for the specs we support — EBU R128 (−23 LUFS) and ATSC A/85 / CALM Act (−24 LKFS) — and flag pass/fail against the selected target.
- FFmpeg's `ebur128` filter gives I/M/S/LRA/true-peak directly; use it as the compute backend.

**Acceptance criteria:**
- Meters show correct channel count with working solo/mute and live true-peak + momentary values.
- Loudness panel reports integrated LUFS, LRA, and max TP; switching gated/ungated changes the integrated value as expected.
- Selecting an EBU R128 or A/85 target shows a clear pass/fail.

---

## 7. Compare Alternate Media  — *Pro*

**What it does:** Open additional media files (up to **16**) to compare against the primary. All open files are listed in a **View → Alternate Media** menu and can be shown in **Full View**, **Split View**, or **Difference View**. Ideal for QC'ing ABR ladders and multi-format deliverables.

**How to build it:**
- Maintain a list of alternate sources with independent decoders but a shared, synchronized transport clock (play/pause/seek apply to all).
- **Full View:** switch which source fills the viewport. **Split View:** side-by-side or wipe with a draggable divider. **Difference View:** per-pixel diff (render both to canvas/WebGL and subtract, or FFmpeg `blend=difference`), with an amplification slider so small differences are visible.
- Handle differing resolutions/frame rates by aligning on timecode and scaling to a common comparison canvas.

**Acceptance criteria:**
- Up to 16 files open and appear in the View menu; transport stays synced across all.
- Split and Difference views render correctly for two sources of differing bitrate/resolution.
- Difference view visibly highlights a known encoding difference between two ABR renditions.

---

## 8. Timeline / GOP Structure  — *Pro*

**What it does:** Visualize the GOP structure of a segment — I, P, and B frames color-coded — alongside per-frame data-rate information.

**How to build it:**
- Use `ffprobe -show_frames -select_streams v` to read `pict_type` (I/P/B) and `pkt_size` per frame for a chosen range.
- Render a horizontal strip under the scrubber: colored ticks per frame by picture type, and a data-rate curve (bytes per frame → bitrate).
- Clicking a frame in the strip seeks the player to it.

**Acceptance criteria:**
- I/P/B frames are correctly classified and color-coded for a long-GOP file.
- Data-rate curve reflects real per-frame sizes; intra-only files show all-I.
- Clicking a GOP tick seeks to that exact frame.

---

## 9. External Monitor Preview (SDI/HDMI)  — *Pro, native addon*

**What it does:** Preview on a broadcast monitor via AJA or Blackmagic Design hardware for QC, and display Vertical Ancillary (VANC) data on the external monitor.

**How to build it:**
- This requires native SDKs, so it's an Electron **native addon** (N-API) rather than pure JS:
  - Blackmagic DeckLink SDK.
  - AJA SDK — target Kona LHi, Kona 4, Kona 3G, T-TAP, Io 4K, Io XT.
- Send decoded frames + audio to the card for genlocked output; expose device/format selection in Preferences.
- Parse and overlay VANC (e.g., embedded captions, AFD, timecode) onto the external output.
- Scope as its own milestone; keep it optional and cleanly degrade when no device is present.

**Acceptance criteria:**
- With a supported AJA/Blackmagic device attached, video+audio output to SDI/HDMI at the correct format.
- VANC data displays on the external monitor.
- No device present → feature is hidden/disabled with a clear message, and the app is otherwise unaffected.

---

## 10. DPP / AS-11 QC  — *Pro*

**What it does:** Visually QC DPP files on the desktop — play them back and display DPP **AS-11 MXF** metadata (aligned with AMWA/DPP compliance).

**How to build it:**
- Parse the AS-11 metadata sets from the MXF header (UK DPP shim: programme title, series/episode, aspect-ratio flags, audio track layout, line-up/loudness, closed-caption flags, etc.).
- Present them in a dedicated "DPP / AS-11" inspector tab, and validate key fields against the AS-11 spec (surface violations).
- Support related broadcast masters (AS-02 versioned masters) as a follow-on.

**Acceptance criteria:**
- An AS-11 DPP file plays and its DPP metadata set is displayed field-by-field.
- Out-of-spec or missing mandatory fields are flagged.

---

## 11. Edit Mode — Export, Rewrap & Transcode ("Fix It")  — *Plus / Pro*

**What it does:** Switch to an edit mode to modify settings and export a new file: choose a new container, new video/audio codec; trim, scale, or crop; add metadata (Pro); and rewrap without re-encoding.

**How to build it:**
- Build on the existing `transcoder.js` (fluent-ffmpeg). Add an export dialog exposing:
  - **Container/codec targets:** Apple ProRes*, H.264, HEVC, MPEG-2 Video, MP4, MPEG-2 Program/Transport Streams, Windows Media (§13).
  - **Trim** (in/out points from the timeline), **scale**, **crop**.
  - **Rewrap / pass-through:** stream-copy video and/or audio (`-c copy`) into a new container; option to drop video and export **audio-only**.
  - **Metadata editing (Pro):** write container metadata on export.
- \*ProRes export: available on macOS via FFmpeg's `prores_ks`; note the platform constraint in the UI. (On Windows, ProRes export is only guaranteed inside Apple-package workflows — see §12.)

**Acceptance criteria:**
- Export produces a valid file in each listed target container/codec.
- Trim/scale/crop are applied correctly and are frame-accurate on trim.
- Rewrap (stream-copy) completes without re-encoding and preserves quality; audio-only export works.

---

## 12. Audio Editing & Apple Package Delivery  — *Plus / Pro*

**What it does (audio editing — Plus/Pro):** In the audio tab, split or join audio tracks, rearrange tracks, change speaker assignments, then change audio format and sample rate. Support **downmix** (e.g., 8-channel → stereo).

**What it does (Apple package — Pro):** Create asset-only Apple/iTunes-style store packages (`.itmsp`) containing media, secondary subtitle/audio files, chapter info, and the package XML — ready for TVOD delivery. Align with the iTunes/Apple TV asset spec (ITT captions, metadata, chapters).

**How to build it:**
- **Audio:** use FFmpeg channel manipulation (`-map`, `amerge`, `pan`, `channelmap`) to split/join/reassign channels; resample with `aresample`; downmix via `pan` matrices. Expose speaker-label assignment in the audio tab.
- **Apple package:** generate the `.itmsp` directory structure (media asset + sidecars + chapters + metadata XML) per the Apple package spec, with an export preset. Use ITT for captions.

**Acceptance criteria:**
- Channels can be split/joined/reassigned; an 8→2 downmix produces correct stereo.
- Sample-rate and format changes export correctly.
- An `.itmsp` package is produced with media, sidecars, chapters, and valid XML that passes basic package validation.

---

## 13. Windows Media & QuickTime Support  — *Core / Plus / Pro*

**What it does:**
- **WMV/WMA playback (Core):** decode and play Windows Media Video/Audio.
- **Convert Windows Media → MP4 (Core):** export WM content to MP4 (H.264 video + AAC audio) for native playback everywhere without third-party tools.
- **Export to Windows Media (Plus/Pro):** convert other formats into WMV/WMA.
- **QuickTime parity:** support the commonly used QuickTime video codecs plus containers/codecs beyond the QuickTime framework; display QuickTime/MOV atom metadata with greater depth than QuickTime Player, and play everything through AJA/Blackmagic when configured (§9).

**How to build it:**
- WMV/WMA decode is covered by FFmpeg (`wmv1/2/3`, `vc1`, `wmav1/2`); route through `stream-decoder.js`.
- WM→MP4 and →WM export are `transcoder.js` presets. Note WMV export requires third-party software to play on macOS; surface that caveat.
- MOV metadata: read QuickTime atoms via ffprobe + a light atom parser for fields ffprobe omits.

**Acceptance criteria:**
- WMV and WMA files play.
- WM→MP4 conversion produces an H.264/AAC MP4 that plays natively on macOS, Windows, and mobile.
- MOV metadata inspection shows at least the fields QuickTime Player shows, plus our added detail.

---

## Build Order (suggested)

1. **§2 Broad format playback** + **§4 Media Inspector** — foundation; mostly FFmpeg wiring, highest immediate value.
2. **§3 Captions** + **§5 Secondary files** — core QC verification.
3. **§6 Audio meters & loudness** — spec compliance (EBU R128 / A/85).
4. **§11 Edit/Export/Rewrap** + **§12 Audio editing** — the "Fix It" workflow.
5. **§1 IMF/DCP** + **§8 Timeline/GOP** + **§7 Compare Alternate Media** — advanced pro playback.
6. **§10 DPP/AS-11** + **§12 Apple packages** — delivery/compliance.
7. **§9 External monitor (AJA/Blackmagic)** — native addon, standalone milestone.

## Cross-cutting notes for the implementer
- Reuse the existing streaming decode path (`stream-decoder.js`) for anything the HTML5 `<video>` element can't play natively; don't add a second playback engine.
- Keep all FFmpeg calls through the bundled `ffmpeg-static` binary; if a codec (HEVC, JPEG 2000, DNxHR) is missing from the shipped build, replace the binary rather than shelling out to a system FFmpeg.
- Everything user-facing stays consistent with the current DaVinci-Resolve-inspired dark UI and QuickTime-style shortcut model.
- Preserve frame-accuracy end-to-end: timecode, trims, seeks, and GOP navigation must all land on exact frames.
