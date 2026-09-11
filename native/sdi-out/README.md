# sdi-out

Sends frame-accurate playback out of a Blackmagic DeckLink or UltraStudio
device to a projector or reference monitor.

**Not built yet.** It needs Blackmagic's Desktop Video SDK, a separate
registration-gated download. The Node side — [`src/sdi.js`](../../src/sdi.js) —
is written and tested; this is the half that talks to the card.

## Why it exists

A screening-room check means putting a sequence on the projector and watching
it run. Doing that today means signing into a paid seat in another application
to perform what is fundamentally a playback test. MaidenPlayer already opens
EXR and DPX sequences and needs no account, so the only missing piece is the
SDI output itself.

## Two constraints that shape the design

**It must not use the H.264 proxy.** Image sequences are normally rendered to
H.264 at CRF 18 in `yuv420p` for the `<video>` element. Sending that down an
SDI cable would put an 8-bit, chroma-subsampled picture on a VFX projector and
invite conclusions about a float render that the picture cannot support. So the
SDI path decodes the source straight to 10-bit 4:2:2 and never touches the
proxy.

**The clock cannot live in Electron's main process.** That thread also runs
IPC, the menus, the auto-updater and garbage collection; a hard real-time frame
schedule sharing it will drop frames, which defeats the point. A separate
process also means a driver fault cannot take the player down mid-screening.

```
EXR / DPX / ProRes → ffmpeg (v210, 10-bit 4:2:2) → sdi-out → DeckLink → SDI
                                                      ↑
                                          control lines on stdin
```

`v210` is the card's native `bmdFormat10BitYUV`, so frames arrive needing no
conversion at all.

## CLI contract

`src/sdi.js` depends on this. Changing it means changing both sides.

### `sdi-out --list-devices`

Print a JSON array and exit `0`. An empty array is a valid answer — no device
connected is a normal state, not an error.

```json
[ { "index": 0, "name": "UltraStudio 4K Mini", "modes": ["bmdMode4kDCI24", "..."] } ]
```

### `sdi-out --play --device N --mode <bmdDisplayMode>`

Read v210 frames from **stdin** and schedule them to the device. Read control
lines from a separate channel (fd 3) so they never collide with frame data:

| Line | Effect |
|---|---|
| `play` | Start or resume scheduled playback |
| `pause` | Hold on the current frame |
| `stop` | Stop playback, disable output |
| `loop on` / `loop off` | Repeat at end of stream |

Write one status line per state change to stderr, prefixed `status:`, so the
player can reflect what the card is actually doing rather than what it was
asked to do.

## Row stride — get this right or the picture shears

v210 packs 6 pixels into 16 bytes, then pads every row to a 128-byte boundary.
DCI widths are not multiples of 6, so a row is **wider** than `width/6*16`:

| Raster | Row bytes | `width/6*16` | Frame bytes |
|---|---|---|---|
| 1280x720 | 3,456 | 3,408 | 2,488,320 |
| 1920x1080 | 5,120 | 5,120 | 5,529,600 |
| 2048x1080 | **5,504** | 5,456 | 5,944,320 |
| 3840x2160 | 10,240 | 10,240 | 22,118,400 |
| 4096x2160 | **11,008** | 10,912 | 23,777,280 |

At 4K DCI the naive figure is short by 207,360 bytes per frame. Copy row by
row using the card's own `GetRowBytes()`, never a single contiguous `memcpy`.

`src/sdi.js` exports `v210RowBytes()` and `v210FrameBytes()`, verified byte for
byte against ffmpeg's v210 encoder at eight widths from 720 to 6144.

## Output modes

32 in all — five rasters across the cinema and broadcast rates:

| Raster | Rates |
|---|---|
| 4096x2160 (4K DCI) | 23.98, 24, 25, 29.97, 30, 50, 59.94, 60 |
| 3840x2160 (UHD) | 23.98, 24, 25, 29.97, 30, 50, 59.94, 60 |
| 2048x1080 (2K DCI) | 23.98, 24, 25, 29.97, 30 |
| 1920x1080 (HD) | 23.98, 24, 25, 29.97, 30, 50, 59.94, 60 |
| 1280x720 | 50, 59.94, 60 |

`deckLinkMode` on each entry is a **hint**, not the authority. The helper must
resolve the real `BMDDisplayMode` by asking the card which modes it supports
and matching on raster plus rate — those enum names shift between SDK versions,
and a stale one fails at output time, after playback appears to have started.

Pass the card's supported list to `matchModeForSource(source, supported)` and
it will never offer a mode the device cannot do.

## Data rates

| Raster | 24 fps | 60 fps |
|---|---|---|
| 1920x1080 | 133 MB/s | 332 MB/s |
| 2048x1080 | 143 MB/s | — |
| 3840x2160 | 531 MB/s | 1,327 MB/s |
| 4096x2160 | 571 MB/s | 1,427 MB/s |

4K needs 12G-SDI on the card, and UHD or 4K at 60 needs roughly 1.4 GB/s
sustained. The pipe carries it; sustained disk read on the EXR source is the
more likely limit.

## Building

Download the Desktop Video SDK from
<https://www.blackmagicdesign.com/developer/products/capture-and-playback/sdk-and-software>
("Desktop Video SDK", Register and Download) and unpack it into
`native/sdi-out/sdk/`. Desktop Video itself — the driver — also has to be
installed on any machine that drives a card.

The output belongs at `src/bin/sdi-out` (`.exe` on Windows), where `src/sdi.js`
looks and which `asarUnpack` already keeps outside the archive.
`MAIDENPLAYER_SDI_OUT` overrides the path for testing.

## Testing

There is no way to emulate an SDI output: verifying playout needs a real card
and a real display. Device enumeration, mode negotiation and the stride maths
are testable without hardware and are covered. Everything past that has to be
confirmed on a rig.
