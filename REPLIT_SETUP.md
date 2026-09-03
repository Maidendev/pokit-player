# PokitPlayer — Replit Development Guide

> **Version**: 1.1.3  
> **Engine**: Electron 28 + FFmpeg streaming decode (fMP4 → MediaSource Extensions)  
> **Architecture**: Real-time transcode pipeline for professional codecs (ProRes, DNxHD/HR, MXF, DPX, EXR)

---

## 📦 Quick Start

### 1. Import into Replit

1. Go to [replit.com](https://replit.com) and click **Create Repl**
2. Choose **Import from ZIP** (or push to GitHub first and import from repo)
3. Upload `PokitPlayer-Replit.zip`
4. Replit will auto-detect the `.replit` and `replit.nix` configurations

### 2. Install Dependencies

```bash
npm install
```

Replit should auto-install on first run, but you can trigger it manually from the Shell tab.

### 3. Run the App

```bash
npm start
```

Or use Replit's **Run** button (▶) which is configured to execute `npm start`.

---

## 🖥 Running Electron on Replit

### Important: Cloud IDE Limitations

Electron is a **desktop GUI framework**. Replit runs in a cloud container, so there are constraints:

| Feature | Local Dev | Replit |
|---------|-----------|--------|
| Full GUI window | ✅ | ⚠️ Requires VNC/Xvfb |
| File drag & drop | ✅ | ❌ |
| Native file dialogs | ✅ | ⚠️ Limited |
| Hardware acceleration | ✅ | ❌ |
| Audio playback | ✅ | ❌ |
| Code editing & refactoring | ✅ | ✅ |
| Build for production | ✅ | ✅ (Linux only) |

### Headless / Xvfb Mode

Replit provides a virtual display. The app is configured to use it:

```bash
# Already set in .replit config:
# DISPLAY=":0"
# ELECTRON_DISABLE_SANDBOX="1"
```

If the display isn't working, start Xvfb manually:

```bash
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99
npm start
```

### Using Replit's Output Panel

For Electron apps, Replit may show the app in its **Output** tab via VNC. If it doesn't render:

1. Open the Shell tab
2. Run `npm run dev:headless` to start with explicit virtual display
3. Check the Output tab for the rendered window

---

## 📁 Project Structure

```
PokitPlayer/
├── .replit              # Replit run configuration
├── replit.nix           # Nix dependencies (FFmpeg, Electron libs, etc.)
├── .gitignore           # Git ignore rules
├── package.json         # npm config with dev/build scripts
├── LICENSE              # MIT License
├── README.md            # Project readme
├── REPLIT_SETUP.md      # This file
│
├── src/
│   ├── main.js          # Electron main process
│   ├── preload.js       # Context bridge (IPC)
│   ├── renderer.js      # UI logic & playback controller
│   ├── stream-decoder.js # Real-time FFmpeg → fMP4 → MSE pipeline
│   ├── transcoder.js    # Transcoding utilities
│   ├── index.html       # Main window markup
│   ├── styles.css       # QuickTime-inspired UI styles
│   ├── assets/          # App icons (ico, icns, png)
│   └── bin/             # ⚠️ Platform FFmpeg binaries (see below)
│
├── scripts/             # Build & signing automation
│   ├── notarize.js      # macOS notarization (electron-builder hook)
│   ├── notarize-linux.sh
│   ├── finish-notarization.sh
│   ├── sign-and-build-mac.sh
│   └── verify-signing.sh
│
├── entitlements.mac.plist
└── entitlements.mac.inherit.plist
```

---

## 🔧 NPM Scripts Reference

| Script | Command | Description |
|--------|---------|-------------|
| `start` | `npm start` | Launch Electron app |
| `dev` | `npm run dev` | Launch in dev mode (DevTools open) |
| `dev:headless` | `npm run dev:headless` | Launch with Xvfb for cloud IDEs |
| `dev:debug` | `npm run dev:debug` | Launch with Node inspector on port 9229 |
| `lint` | `npm run lint` | Check code style with ESLint |
| `build` | `npm run build` | Build for current platform |
| `build:linux` | `npm run build:linux` | Build Linux AppImage + deb |
| `build:win` | `npm run build:win` | Build Windows installer (cross-compile) |
| `build:mac` | `npm run build:mac` | Build macOS dmg + zip (unsigned) |
| `pack` | `npm run pack` | Package without creating installer (fast test) |
| `clean` | `npm run clean` | Remove dist/ and node_modules/ |

---

## 🎬 FFmpeg Binary Handling

### The Problem

PokitPlayer bundles **platform-specific FFmpeg binaries** in `src/bin/` for distribution builds:

- `ffmpeg-darwin` — macOS Intel (x64) — 76 MB
- `ffmpeg-darwin-arm64` — macOS Apple Silicon — 44 MB  
- `ffmpeg.exe` — Windows x64 — 79 MB

These are **excluded from the Replit package** to keep the ZIP small (~2 MB vs ~200 MB).

### On Replit (Development)

The `replit.nix` configuration installs **FFmpeg system-wide** via Nix:

```nix
pkgs.ffmpeg-full
```

The app's `stream-decoder.js` already has a fallback chain for finding FFmpeg:

1. Bundled binary in `src/bin/` (for production builds)
2. `ffmpeg-static` npm package
3. System PATH `ffmpeg` ← **This is what Replit uses**

**No code changes needed** — it will automatically find the Nix-provided FFmpeg.

### For Production Builds

Binaries are fetched or built by script — never downloaded by hand:

```bash
npm run ffmpeg:fetch              # Windows / Linux: pinned LGPL build, SHA-256 verified
./scripts/build-ffmpeg-macos.sh   # macOS: compiled from pinned source (run on a Mac)
npm run ffmpeg:verify             # confirm nothing GPL or non-distributable got in
```

`npm install` runs the fetch automatically.

> **Do not download an FFmpeg build yourself.** This section used to tell you to
> pull binaries from evermeet.cx and gyan.dev. Both of those are **GPL** builds —
> they enable x264 and x265, which force FFmpeg's `--enable-gpl` — and following
> those instructions is how GPL-3 binaries ended up in shipped installers. The
> macOS arm64 binary in use before this change was worse still: it carried
> `--enable-nonfree` and could not lawfully be redistributed at all.
>
> `npm run ffmpeg:verify` reads the build configuration compiled into each binary
> and fails on any GPL or non-distributable flag. It runs on `prebuild` and in CI.
> See `src/bin/README.md` and `docs/oss/` for the detail.

---

## 🔐 Code Signing & Notarization

The signing infrastructure is included for reference but is **only used for final distribution**:

### Files Included (Reference Only)

- `scripts/notarize.js` — electron-builder afterSign hook
- `scripts/notarize-linux.sh` — Cross-platform signing from Linux
- `scripts/finish-notarization.sh` — Post-approval stapling
- `entitlements.mac.plist` — macOS entitlements
- `entitlements.mac.inherit.plist` — Inherited entitlements

### Files NOT Included (Security)

These are intentionally excluded from the Replit package:

- `Certificates.p12` — Apple Developer signing certificate
- `AuthKey_*.p8` — App Store Connect API key
- `developerID_application.cer` — Developer ID certificate

### To Set Up Signing on Your Local Machine

1. Export your Developer ID certificate as `.p12` from Keychain Access
2. Download your App Store Connect API key from [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
3. Place files in the project root
4. Set environment variables:
   ```bash
   export APPLE_TEAM_ID="your-team-id"
   export APPLE_API_KEY_ID="your-key-id"
   export APPLE_API_ISSUER_ID="your-issuer-id"
   ```
5. Run: `npm run build:mac:signed`

---

## 🐛 Troubleshooting on Replit

### "Cannot find module 'electron'"

```bash
npm install
# If that fails:
npm install --force
```

### "Error: spawn ENOENT" (FFmpeg not found)

```bash
# Verify FFmpeg is available
which ffmpeg
ffmpeg -version

# If missing, the Nix env may not have loaded. Try:
# 1. Refresh the Repl (Ctrl+Shift+R)
# 2. Or install manually:
nix-env -iA nixpkgs.ffmpeg-full
```

### Display / GPU errors

```bash
# Electron needs these flags on headless systems:
export ELECTRON_DISABLE_SANDBOX=1
export ELECTRON_DISABLE_GPU=1

# Or use the headless script:
npm run dev:headless
```

### "libnss3.so: cannot open shared object"

The `replit.nix` should provide all shared libraries. If you see missing `.so` errors:

```bash
# Check what's missing
ldd $(which electron) | grep "not found"

# The replit.nix LD_LIBRARY_PATH should cover these
# If not, add the missing package to replit.nix deps
```

### Build fails on Replit

Replit can only build **Linux** targets. For macOS/Windows:
- Use GitHub Actions CI/CD
- Build locally on the target platform
- Use a cross-compilation service

---

## 🚀 Recommended Replit Workflow

1. **Edit code** in Replit's editor (full IntelliSense via TypeScript LSP)
2. **Test basic logic** with `npm run dev:headless`
3. **Build Linux packages** with `npm run build:linux`
4. **Push to GitHub** for CI/CD builds targeting macOS/Windows
5. **Sign & notarize** on a macOS machine or in a macOS CI runner

---

## 📝 Key Source Files to Edit

| File | Purpose | What to modify |
|------|---------|----------------|
| `src/renderer.js` | UI controls, keyboard shortcuts | Add features, fix UI bugs |
| `src/stream-decoder.js` | FFmpeg → MSE pipeline | Codec support, performance tuning |
| `src/styles.css` | QuickTime-style UI | Visual design changes |
| `src/main.js` | Electron main process | Window management, menus, IPC |
| `src/index.html` | Main window markup | Layout structure |
| `src/preload.js` | IPC bridge | New API endpoints |
| `src/transcoder.js` | Transcoding utilities | Format conversion features |

---

*Last updated: June 2026 — PokitPlayer v1.1.3*
