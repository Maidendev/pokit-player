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

#### File Information Viewer
- Video resolution, aspect ratio, and frame rate
- File size, format, and modification date
- Audio track detection

#### QuickTime Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Space` | Play / Pause |
| `J` / `K` / `L` | Shuttle backward / stop / forward (Premiere/FCP-style — tap J or L again to ramp speed 2x–8x) |
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
