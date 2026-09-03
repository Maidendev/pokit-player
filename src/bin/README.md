# FFmpeg Binaries

This directory holds the LGPL `ffmpeg` and `ffprobe` binaries the player ships.
**Do not place binaries here by hand.** They are fetched or built by script, and
every one of them is licence-checked before it can be packaged.

## Getting them

```bash
npm run ffmpeg:fetch        # Windows / Linux — pinned LGPL build, SHA-256 verified
./scripts/build-ffmpeg-macos.sh   # macOS — compiled from pinned source
```

`npm install` runs the fetch automatically via `postinstall`.

| File | Platform | Source |
|------|----------|--------|
| `ffmpeg.exe`, `ffprobe.exe` | Windows x64 | BtbN LGPL build, pinned |
| `ffmpeg`, `ffprobe` | Linux x64 | BtbN LGPL build, pinned |
| `ffmpeg-darwin-x64`, `ffprobe-darwin-x64` | macOS Intel | built from source |
| `ffmpeg-darwin-arm64`, `ffprobe-darwin-arm64` | macOS Apple Silicon | built from source |
| `FFMPEG-LICENSE.txt` | all | copied from the build, ships with the app |

None of these are committed — see `.gitignore`. The pinned URL, the SHA-256 and
the licence gate are the record of what they are.

## Why you must not just download an FFmpeg

Almost every FFmpeg binary published on the internet is **GPL**, because the
common builds enable x264 and x265, which are GPL and force FFmpeg's
`--enable-gpl`. Some are worse: the macOS arm64 build this project used to ship
was flagged `--enable-nonfree`, which made it not redistributable at all.

The build configuration is compiled into the binary, so it can be checked:

```bash
npm run ffmpeg:verify
```

That gate fails the build on `--enable-gpl`, `--enable-nonfree`, or any GPL-only
library. It runs on `prebuild` and in CI. If you add a binary here that does not
pass, the build stops — which is the point.

Sources and pins live in `scripts/ffmpeg-sources.json`. Background and the full
component inventory are in `docs/oss/`.

## Architecture matters on macOS

There is deliberately no generic `ffmpeg-darwin` name any more. Each macOS
architecture gets its own natively-built binary. Reusing one for the other is
how an arm64 binary previously ended up inside the Intel DMG, where it could not
execute at all.
