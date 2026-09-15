# MaidenPlayer

A professional, cross-platform desktop video player built with Electron. Features a sleek DaVinci Resolve-inspired dark interface, QuickTime-style keyboard shortcuts, frame-accurate timecode display, and file information viewer.

![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Electron](https://img.shields.io/badge/electron-28-purple)

---

### Features

#### Core Playback
- Play, pause, seek through common video formats (MP4, WebM, MKV, AVI, MOV)
- Smooth playback with frame-rate detection
- Volume control with mute toggle
- Native fullscreen mode
- Frame-by-frame navigation (forward & backward)
- Loop playback — repeats seamlessly, which matters for image-sequence review
  and screening-room checks

#### Timecode Display
- Real-time HH:MM:SS:FF timecode (Hours:Minutes:Seconds:Frames)
- Frame-accurate updates using `requestVideoFrameCallback` API
- Automatic frame rate detection with snapping to common rates (23.976, 24, 25, 29.97, 30, 60 fps)

#### Window Size Options
- **Quarter Size (25%)** — Resize window to 25% of video resolution (`⌘1` / `Ctrl+1`)
- **Half Size (50%)** — Resize window to 50% of video resolution (`⌘2` / `Ctrl+2`)
- **Full Size (100%)** — Resize window to 100% of video resolution (`⌘3` / `Ctrl+3`)

#### Media Inspector ("Check It")
Deep inspection via ffprobe, in a summary view with an expandable **Advanced** section:
- **Video** — resolution, display & pixel aspect ratio, clean aperture, frame rate, scan type
  and field order, bit depth, chroma subsampling, codec profile/level, GOP structure
- **Color & HDR** — primaries, transfer, matrix, range; HDR10 / HLG / PQ detection with
  mastering-display primaries, luminance, MaxCLL and MaxFALL
- **Audio** — codec, channel count with speaker labels (L/R/C/LFE/Ls/Rs), sample rate,
  bit depth, per-track bitrate
- **Container** — format, duration, start timecode, reel name, MPEG-TS program/PID
  structure, timecode tracks, chapters and container metadata
- Properties the file doesn't carry are marked "—" rather than hidden

#### Professional Format Playback
- **Containers** — MXF (OP1a), GXF, MPEG-2 Transport & Program Streams, MOV, MP4,
  WMV/ASF, MKV, WebM, AVI, MJ2
- **Video codecs** — H.264, HEVC (incl. 4K), MPEG-2, Apple ProRes (Proxy/LT/422/HQ/4444/4444 XQ),
  DNxHD & DNxHR, JPEG 2000, VC-1, Windows Media
- **Blackmagic RAW** — `.braw` plays through Blackmagic's own SDK, since FFmpeg
  has no Blackmagic RAW decoder. Needs the `braw-decode` helper to be built and
  bundled; see [native/braw-decode](native/braw-decode/README.md). Video only
  for now — `.braw` audio is not wired up yet.

#### External Video Output (Blackmagic SDI)
- **Playback ▸ External Video Output** lists every connected DeckLink or
  UltraStudio and routes playback out of it over SDI — the equivalent of RV's
  Present Mode, with no account to sign into. Pick the device; play, pause,
  seek and loop drive the card; a badge by the title shows the device is live.
- Image sequences go out as the **original EXR/DPX frames** decoded to 10-bit
  4:2:2, never the H.264 preview proxy. Output mode is chosen from what the
  card itself reports it can drive, so a 24p sequence never lands on a 23.98
  mode. Details, the stride trap and decode-speed limits are in
  [native/sdi-out](native/sdi-out/README.md). macOS only for now.
- **Audio codecs** — AAC, MP3, Opus, Vorbis, FLAC play natively; AC-3, E-AC-3, DTS,
  TrueHD and PCM are decoded through the streaming path
- A file plays natively only when the container, video codec **and** audio codec are all
  ones Chromium handles — otherwise it routes through the streaming decoder. Chromium has
  no AC-3/DTS decoder, so without the audio check those files would play picture with
  silent audio and no error at all

#### Captions & Subtitles
- **Sidecar formats** — SRT, WebVTT, SCC (CEA-608), TTML / IMSC1, iTT, DFXP, EBU STL
- **Embedded** — extract CEA-608 captions carried in MXF, MPEG-TS and MOV
- Overlay renders over picture in transcoded and streamed playback alike
- Malformed caption files report a specific parse error instead of failing silently

#### Audio Meters & Loudness (`⌘⇧L` / `Ctrl+Shift+L`)
- Always-on channel meters docked to the right of the picture — one thin bar per
  channel, so the track count and layout (STEREO, 5.1, …) are readable at a glance.
  Fades with the transport bar when the mouse goes idle
- Per-channel meters with speaker labels, peak hold, and solo/mute per channel
- Program loudness to **ITU-R BS.1770** via `ebur128`: integrated, LRA, max true peak
- Gated (BS.1770-3/-4) and ungated (BS.1770-2) modes
- Pass/fail against **EBU R128** (−23 LUFS) and **ATSC A/85 / CALM Act** (−24 LKFS)

#### GOP / Data Rate Strip (`⌘G` / `Ctrl+G`)
- I / P / B frames colour-coded per frame, with a per-frame data-rate curve
- Click any frame to seek to it exactly
- Intra-only codecs (ProRes, DNxHR, JPEG 2000) show as all-I

#### Secondary File Sync Check
- Load a secondary audio file or caption file against the primary picture
- Frame-accurate offset nudge (± frames, shown in ms) applied live

#### Editing — the QuickTime 7 Pro utility layer
Small media operations that used to need an NLE. Every one writes a **new** file
through the bundled ffmpeg; the loaded media is never modified. Progress shows in a
corner toast while playback continues; **Show in Folder** / **Open** when it lands.

- **In / Out selection** — `I` and `O` set the points, `Shift+I` / `Shift+O` jump to
  them, `⌘⇧X` clears. The selection is highlighted on the scrubber and an edit bar shows
  In, Out and duration in source timecode with **Play Sel**, **Trim…**, **Delete…**,
  **To Bin** and **Export…**
- **Lossless where possible** — trims, deletes, joins, audio replace/remove and
  extraction are **stream copies** (`-c copy`): no decode, no re-encode, bit-identical
  picture, finished at disk speed. Intra-only codecs (ProRes, DNxHD/HR, JPEG 2000,
  MJPEG) cut frame-accurately. Long-GOP sources (H.264, HEVC, MPEG-2) can only be cut on
  keyframes, so the dialog **shows where the lossless cut will actually land** (e.g.
  `In 00:00:04:04 (−1 fr), Out 00:00:09:20 (+3 fr)`) and offers a frame-accurate encode
  instead. The source timecode is carried into the new file, offset to the cut.
- **Copy and paste between windows** — with an In → Out selection, `⌘C` puts the clip
  on the system clipboard, so it travels to a second MaidenPlayer window. `⌘V` there
  asks **Insert** (cut at the paste point and shuffle the rest down) or **Overwrite**
  (lay the clip on top, no shuffle) and saves a new movie. The paste lands at the In
  point if one is set, otherwise at the playhead. Lossless when the two movies match;
  otherwise conformed to the destination and encoded. In a text field `⌘C` / `⌘V`
  copy and paste text as usual.
- **Export…** (`⌘E`) — whole movie or In → Out; Lossless, Apple ProRes 422 HQ / 422 /
  4444, Avid DNxHR HQ / HQX, or H.264. Optionally **bake in the active LUT**.
- **Append / Combine Movies** (`⌘⇧B`) — an ordered list of movies and clip-bin
  selections, reorderable, saved as one file. The panel says whether a **lossless join**
  is possible and, if not, exactly which property differs (codec, raster, pixel format,
  frame rate, audio layout); mismatched inputs are conformed to the first movie and
  encoded. **File ▸ Append Movie…** is the one-step version.
- **Save Current Frame** (`⌘⇧S`) — PNG, JPEG, TIFF, DPX or OpenEXR from the **source**
  (never the playback proxy). 10-bit and float sources write 16-bit / 10-bit DPX / float
  EXR. If the LUT is on, the still matches what is on screen.
- **Audio** (File ▸ Audio) — Extract as WAV / AIFF (24-bit) or original codec in a MOV;
  Remove Audio; Replace Audio; Add Audio Track; **Mute Channels** per channel with the
  file's own speaker labels (only tracks with a muted channel are re-encoded).
- **Markers** — `M` drops a marker at the exact source timecode; `Shift+↑` / `Shift+↓`
  walk them, `Alt+M` deletes the one under the playhead. Markers show on the scrubber,
  can be named in the Markers panel (`⌘⇧M`), persist per file, and export as CSV, text
  or JSON.

#### Look & Framing (`⌘⇧F` / `Ctrl+Shift+F`)
For VFX review, dailies and screenings.

- **LUT support** — load a `.cube` (1D or 3D, up to 129³), toggle it with `U` during
  playback. The desktop preview runs on the GPU (WebGL2, 16-bit float texture,
  trilinear). Everything that leaves the player — **Blackmagic SDI output**, exports and
  saved frames — applies the same file through ffmpeg's `lut3d` with tetrahedral
  interpolation. **Apply LUT to External Video Output** decides whether the projector
  gets the look.
- **Aspect-ratio masks** — one-click **1.43 · 1.78 · 1.85 · 2.39 · 2.40 · 9:16 · 4:5**
  plus a custom ratio, with an **adjustable opacity** from a dim to a full mask.
- **Guides** — center crosshair, action safe (93%) and title safe (90%) per
  SMPTE ST 2046-1 / EBU R95, drawn relative to the masked frame.

Mask and LUT settings persist between launches and are mirrored in the View menu.

#### QuickTime Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `J` / `L` | Shuttle backward / forward (Premiere/FCP-style — tap again to ramp 2x–8x, tap the other key to step back down) |
| `K`+`J` / `K`+`L` | Slow shuttle (half speed) |
| `←` / `→` | Frame-by-frame backward / forward |
| `⌘←` / `⌘→` (or `Ctrl`) | Jump 1 second backward / forward |
| `⌘L` (or `Ctrl+L`) | Loop playback on / off |
| `⌘⇧L` (or `Ctrl+Shift+L`) | Audio meters & loudness |
| `↑` / `↓` | Volume up / down |
| `Shift+M` | Mute / Unmute (bare `M` is now Add Marker) |
| `F` | Toggle fullscreen |
| `0`–`9` | Jump to 0%–90% of video |
| `⌘1` / `Ctrl+1` | Quarter size (25%) |
| `⌘2` / `Ctrl+2` | Half size (50%) |
| `⌘3` / `Ctrl+3` | Full size (100%) |
| `⌘O` / `Ctrl+O` | Open file |
| `⌘I` / `Ctrl+I` | Toggle file info panel |
| `I` / `O` | Set In / Out point |
| `Shift+I` / `Shift+O` | Go to In / Out |
| `⌘⇧X` / `Ctrl+Shift+X` | Clear In and Out |
| `⌘E` / `Ctrl+E` | Export… (whole movie or In → Out) |
| `⌘C` / `Ctrl+C` | Copy In → Out as a clip (to the clipboard, for any window) |
| `⌘V` / `Ctrl+V` | Paste clip into this movie: Insert or Overwrite |
| `⌘B` / `Ctrl+B` | Copy selection to the clip bin |
| `⌘⇧B` / `Ctrl+Shift+B` | Combine Movies panel |
| `⌘⇧S` / `Ctrl+Shift+S` | Save current frame as a still |
| `M` | Add marker at the source timecode |
| `Alt+M` | Delete marker at playhead |
| `Shift+↑` / `Shift+↓` | Previous / next marker |
| `⌘⇧M` / `Ctrl+Shift+M` | Markers panel |
| `⌘U` / `Ctrl+U` | Load LUT |
| `U` | Toggle LUT on / off |
| `⌘⇧F` / `Ctrl+Shift+F` | Look & Framing panel (LUT, masks, guides) |

#### UI Design
- Dark, professional interface inspired by DaVinci Resolve
- Auto-hiding controls during playback
- Professional timeline scrubber with buffering indicator
- Drag-and-drop file support
- Responsive layout

---

### Getting Started

#### Prerequisites
- [Node.js](https://nodejs.org/) v18 or later
- npm (included with Node.js)

#### Installation

```bash
# Clone the repository
git clone <repo-url>
cd professional_video_player

# Install dependencies
npm install

# Run the application
npm start
```

#### Development Mode

```bash
npm run dev
```

---

### Building for Distribution

Build packages for your platform:

```bash
# Build for current platform
npm run build

# Build for specific platforms
npm run build:win      # Windows (NSIS installer + portable)
npm run build:mac      # macOS (DMG + ZIP)
npm run build:linux    # Linux (AppImage + DEB)

# Build for all platforms
npm run build:all
```

Output binaries will be in the `dist/` directory.

---

### Project Structure

```
professional_video_player/
├── package.json          # Dependencies, scripts, and build config
├── README.md             # This file
├── LICENSE               # MIT License
└── src/
    ├── main.js           # Electron main process
    ├── preload.js        # Preload script (IPC bridge)
    ├── index.html        # Application UI
    ├── styles.css        # DaVinci Resolve-inspired styling
    ├── editing.css       # In/Out bar, markers, combine, look & framing panels
    ├── renderer.js       # Playback engine, UI logic, shortcuts, editing UI
    ├── editor.js         # ffmpeg media operations: trim, delete, combine, stills, audio
    ├── lut.js            # .cube parser + WebGL2 LUT preview (renderer)
    ├── masks.js          # Aspect-ratio masks and framing guides (renderer)
    ├── sdi.js            # Blackmagic SDI output (optionally through the LUT)
    └── assets/
        ├── icon.png      # App icon (PNG, 512×512)
        └── icon.ico      # App icon (ICO, multi-resolution)
```

---

### Technical Details

- **Electron** for cross-platform desktop packaging
- **HTML5 `<video>`** element for codec support (MP4/H.264, WebM/VP8/VP9, Ogg)
- **`requestVideoFrameCallback`** for frame-accurate timecode
- **Context isolation** and **Content Security Policy** for security
- **IPC** (Inter-Process Communication) between main and renderer via preload bridge

#### Release identity — do not change these

Two values in `package.json` are the app's permanent identity to the
auto-updater, and changing either one silently breaks updates for everyone
already installed:

- **`build.appId`** (`com.maidenplayer.app`). On macOS this is the bundle
  identifier, and Squirrel only applies an update whose signature satisfies
  the running app's designated requirement — which embeds the identifier. A
  changed appId is rejected as a different program.
- **`build.nsis.guid`** (`69b674bf-4830-5868-9553-d10f90dcff58`). On Windows
  the NSIS installer keys the install, the uninstall registry entry and the
  shortcuts to this GUID. It is pinned to the value electron-builder derived
  from the *original* appId, `com.pokitplayer.app`, so that installs of
  PokitPlayer 1.2.x upgrade in place to MaidenPlayer rather than installing a
  second copy alongside. Without the pin, electron-builder would derive a
  new GUID from the new appId.

Rename the product, the shortcuts, the artifacts freely — but never these.

#### Supported Formats

Format support depends on the platform's Chromium build:

| Format | Codec | Support |
|---|---|---|
| MP4 | H.264/AAC | ✅ All platforms |
| WebM | VP8/VP9/Opus | ✅ All platforms |
| Ogg | Theora/Vorbis | ✅ All platforms |
| MKV | H.264 | ⚠️ Container support varies |
| AVI | Various | ⚠️ Limited — depends on codec |
| MOV | H.264 | ⚠️ Typically works on macOS |

---

### License

This project is licensed under the **MIT License**. See [LICENSE](./LICENSE) for details.
