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
| `pixelFormat` | string | An **FFmpeg** pixel format name matching the bytes `--frames` emits, e.g. `rgba64le` for 16-bit RGBA |
| `hasAudio` | boolean | Whether the clip carries PCM |
| `audioChannels` | number | Channel count when `hasAudio` |
| `codecFriendly` | string | Display name, e.g. `"Blackmagic RAW 8:1"` |
| `compressionRatio` | string | e.g. `"8:1"` |
| `colorScience` | string | e.g. `"Gen 5"` |
| `iso`, `whiteBalance` | number | Camera metadata for the inspector |
| `timecode` | string | Start timecode, `"01:00:00:00"` |

On failure: write a human-readable reason to **stderr** and exit non-zero. The
player surfaces that text directly, so it should read as an explanation, not a
stack trace.

### `braw-decode --frames <file> [--start-frame N] [--audio-out <file.wav>]`

Write frames to stdout, back to back, no header or padding, in the pixel
format `--info` reported. Start at frame `N` (default `0`) — the player seeks
by frame because rawvideo has no timestamps for FFmpeg's `-ss` to act on.

Honour backpressure: when stdout blocks, stop decoding. The player throttles
the pipe deliberately so a fast decode cannot saturate the UI thread.

`--audio-out` is accepted but **not yet used by the player**; see below.

## Building

The SDK is not in this repository. Download **Blackmagic RAW SDK** from
<https://www.blackmagicdesign.com/developer/products/braw/sdk-and-software>
(free, but it requires a Blackmagic account and accepting their licence), then
unpack it here:

```
native/braw-decode/sdk/
    include/          BlackmagicRawAPI.h and friends
    lib/              the platform's runtime libraries
```

Then build for the host platform:

```
cmake -S native/braw-decode -B native/braw-decode/build -DCMAKE_BUILD_TYPE=Release
cmake --build native/braw-decode/build --config Release
```

The result must land at `src/bin/braw-decode` (`.exe` on Windows), which is
where `src/braw.js` looks and which `asarUnpack` already keeps outside the
archive. `MAIDENPLAYER_BRAW_DECODE` overrides the path for local testing.

macOS builds need both architectures, since the app ships separate Intel and
Apple Silicon bundles — the same split the CI workflow already handles for
FFmpeg.

## Redistribution

The installers bundle the SDK's runtime libraries, so **Blackmagic's
redistribution terms apply to MaidenPlayer's releases** and want reviewing
before shipping publicly. Everything Blackmagic-specific is deliberately
confined to this directory, `src/braw.js`, and one branch in
`src/stream-decoder.js`, so switching to "detect the user's own Blackmagic RAW
install instead of bundling" is a change to `getDecoderPath()` and the build,
not a rewrite.

## Not done yet

- **Audio.** `.braw` carries PCM, but the player currently decodes `.braw`
  video only. The helper has to finish writing the PCM to a file before FFmpeg
  can add it as a second input, and that pre-pass has to complete before frame
  decoding starts — which `StreamDecoder.start()` being synchronous does not
  allow. The `--audio-out` flag is specified above so the contract does not
  have to change when this is wired up.
- **DeckLink output.** Playing out to a DeckLink card for reference monitoring
  is a separate feature needing the Desktop Video SDK, not this one.
