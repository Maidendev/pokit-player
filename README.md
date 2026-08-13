# PokitPlayer

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

#### Audio Meters & Loudness (`⌘L` / `Ctrl+L`)
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

#### QuickTime Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `J` / `L` | Shuttle backward / forward (Premiere/FCP-style — tap again to ramp 2x–8x, tap the other key to step back down) |
| `K`+`J` / `K`+`L` | Slow shuttle (half speed) |
| `←` / `→` | Skip 5 seconds backward / forward |
| `⌘←` / `⌘→` (or `Ctrl`) | Frame-by-frame backward / forward |
| `↑` / `↓` | Volume up / down |
| `M` | Mute / Unmute |
| `F` | Toggle fullscreen |
| `0`–`9` | Jump to 0%–90% of video |
| `⌘1` / `Ctrl+1` | Quarter size (25%) |
| `⌘2` / `Ctrl+2` | Half size (50%) |
| `⌘3` / `Ctrl+3` | Full size (100%) |
| `⌘O` / `Ctrl+O` | Open file |
| `⌘I` / `Ctrl+I` | Toggle file info panel |

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
    ├── renderer.js       # Playback engine, UI logic, shortcuts
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
