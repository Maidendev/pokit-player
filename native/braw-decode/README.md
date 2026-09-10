# braw-decode

A small native helper that turns Blackmagic RAW into raw frames, so
MaidenPlayer can play `.braw` files.

## Why this exists

Every other format in MaidenPlayer is decoded by the bundled FFmpeg. `.braw`
cannot be, because **FFmpeg has no Blackmagic RAW support at all** — there is
no demuxer and no decoder, and Blackmagic have said they do not intend to
contribute one. `ffmpeg -i clip.braw` fails before reading a single frame.

The only way to decode `.braw` is Blackmagic's own SDK, which is C++. This
helper is the smallest possible bridge: it uses the SDK to produce raw frames
and writes them to stdout, and then the player's existing pipeline takes over
unchanged.

```
.braw → braw-decode (SDK, GPU decode) → rawvideo on stdout
      → ffmpeg (H.264 → fMP4) → IPC → MediaSource → <video>
```

Doing it this way means seeking, backpressure and the transport all keep
working exactly as they do for ProRes, rather than needing a second playback
path. The Node side lives in [`src/braw.js`](../../src/braw.js).

## CLI contract

`src/braw.js` depends on this exactly. Changing it means changing both sides.

### `braw-decode --info <file>`

Print **one JSON object** to stdout and exit `0`. Unknown fields should be
omitted rather than guessed.

| Field | Type | Notes |
|---|---|---|
| `width`, `height` | number | Frame geometry in pixels |
| `frameRate` | number | e.g. `23.976` |
| `frameRateRational` | string | e.g. `"24000/1001"` — passed to FFmpeg verbatim so fractional rates do not drift |
| `frameCount` | number | Total frames; the player derives duration from this and `frameRate` |
| `pixelFormat` | string | An **FFmpeg** pixel format name matching the bytes `--frames` emits. Default `rgb48le` (16-bit RGB, 6 bytes/pixel) |
| `hasAudio` | boolean | Whether the clip carries PCM |
| `audioChannels`, `audioSampleRate`, `audioBitDepth`, `audioSampleCount` | number | Present when `hasAudio` |
| `codecFriendly` | string | Display name including the ratio, e.g. `"Blackmagic RAW 3:1"` |
| `compressionRatio` | string | e.g. `"3:1"`, from `braw_compression_ratio` |
| `colorScience` | string | e.g. `"Gen 4"`, derived from `viewing_bmdgen` |
| `cameraType` | string | e.g. `"Blackmagic URSA Mini Pro 4.6K"` |
| `timecode` | string | Start timecode, `"22:23:40:20"` |
| `reelName`, `clipNumber`, `scene`, `take`, `goodTake`, `lensType`, `cameraNumber`, `dateRecorded`, `firmwareVersion`, `viewingGamma`, `viewingGamut` | string | Production metadata, each omitted when the clip does not carry it |

`iso` and `whiteBalance` are **not** emitted — they are per-frame metadata in
Blackmagic RAW; see "Not done yet".

`--dump-metadata <file>` lists every key a clip carries. That is how the key
names above were established rather than guessed.

On failure: write a human-readable reason to **stderr** and exit non-zero. The
player surfaces that text directly, so it should read as an explanation, not a
stack trace.

### `braw-decode --frames <file> [--start-frame N] [--audio-out <file.wav>]`

Write frames to stdout, back to back, no header or padding, in the pixel
format `--info` reported. Start at frame `N` (default `0`) — the player seeks
by frame because rawvideo has no timestamps for FFmpeg's `-ss` to act on.

Honour backpressure: when stdout blocks, stop decoding. The player throttles
the pipe deliberately so a fast decode cannot saturate the UI thread.

`--pixel-format rgb48le|rgba64le` overrides the output format; `--info` always
reports whichever will be used.

`--audio-out` is implemented but **not yet used by the player**; see below.

## Getting the SDK

Blackmagic do not publish the SDK as a plain archive. It is a payload **inside
the Blackmagic RAW installer**, and the download needs a Blackmagic account, so
it cannot be fetched by a build script. Download Blackmagic RAW from
<https://www.blackmagicdesign.com/developer/products/braw/sdk-and-software>,
drop the installers into `sdk/`, and unpack them:

```
native/braw-decode/sdk/Blackmagic_RAW_5.1.dmg          (macOS)
native/braw-decode/sdk/Install Blackmagic RAW 5.1.msi  (Windows)

scripts/extract-braw-sdk.sh
```

That mounts the disk image read-only and expands the `.pkg` payload with
`pkgutil` — it never runs the installer, so nothing is written outside the
repository and no system-wide Blackmagic install is needed. It leaves:

```
sdk/Mac/Include        BlackmagicRawAPI.h
sdk/Mac/Libraries      BlackmagicRawAPI.framework   (universal: x86_64 + arm64)
sdk/Win/Include        BlackmagicRawAPIDispatch.h and .cpp
sdk/Linux/Include      BlackmagicRawAPI.h, LinuxCOM.h
sdk/Media/sample.braw  a real URSA Mini Pro clip, for testing
sdk/License.rtf        Blackmagic's licence — read it before shipping
```

## Building

```
scripts/build-braw-decode.sh          # macOS, no CMake needed
```

or, cross-platform:

```
cmake -S native/braw-decode -B native/braw-decode/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/braw-decode/build --config Release
```

Both produce `src/bin/braw-decode` — where `src/braw.js` looks, and which
`asarUnpack` already keeps outside the archive — plus a copy of
`BlackmagicRawAPI.framework` beside it. `MAIDENPLAYER_BRAW_DECODE` overrides
the path for local testing.

The macOS binary is built universal, so one helper serves both the Intel and
Apple Silicon app bundles. The framework already ships both slices, so this
costs nothing.

### Two things about linking that cost time to discover

**Only one factory entry point actually exists.** The header declares
`CreateBlackmagicRawFactoryInstance`, `...FromPath` and
`...FromExeRelativePath`, and the SDK's own samples call the path-based ones —
but `nm -gU` on the macOS framework lists **only the no-argument form**. So the
framework has to be found by the dynamic loader instead, which is why the
helper links it and carries `-rpath @loader_path`.

**Copy the whole framework bundle, not just its binary.** The framework loads
its own inner decoders — `DecoderMetal`, `DecoderOpenCL`,
`InstructionSetServicesAVX`/`AVX2` — from `Libraries/` inside itself. Without
them it opens a clip and then fails at decode time.

## Redistribution

The installers bundle the SDK's runtime libraries, so **Blackmagic's
redistribution terms apply to MaidenPlayer's releases** and want reviewing
before shipping publicly. Everything Blackmagic-specific is deliberately
confined to this directory, `src/braw.js`, and one branch in
`src/stream-decoder.js`, so switching to "detect the user's own Blackmagic RAW
install instead of bundling" is a change to `getDecoderPath()` and the build,
not a rewrite.

## Verified

Against `sdk/Media/sample.braw`, a real URSA Mini Pro 4.6K clip:

- `--info` reports 4608x2592, 24 fps, `rgb48le`, 2ch/48kHz/24-bit audio, plus
  compression ratio, colour science generation, reel, scene, take, lens and
  camera metadata.
- `--frames` emits exactly 71,663,616 bytes for one 4608x2592 frame at 6 bytes
  per pixel, and piping it into FFmpeg with the geometry `--info` reported
  renders the frame correctly — right colours, no channel swap, no stride
  error.
- The full player path produces valid fMP4 at 4608x2592 through
  `StreamDecoder`.

## Not done yet

- **Audio.** `--audio-out` is implemented here and writes a RIFF/WAVE file, but
  the **player does not use it yet**: FFmpeg needs the PCM complete before it
  can take it as a second input, and that pre-pass has to finish before frame
  decoding starts, which `StreamDecoder.start()` being synchronous does not
  allow.
- **ISO and white balance.** These are per-**frame** metadata in Blackmagic
  RAW, not clip metadata, so reading them would put a frame read in front of
  every file open. `--info` omits them and the inspector reports them as
  absent.
- **CI.** The installers are ~186 MB and the SDK cannot be downloaded
  unattended, so the release workflow does not build this helper yet. Until it
  does, shipped installers have no `.braw` support and say so.
- **DeckLink output.** Playing out to a DeckLink card for reference monitoring
  is a separate feature needing the Desktop Video SDK, not this one.
