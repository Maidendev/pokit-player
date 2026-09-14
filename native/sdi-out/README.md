# sdi-out

Sends frame-accurate playback out of a Blackmagic DeckLink or UltraStudio
device over SDI, to a projector or reference monitor.

**In the app:** Playback ▸ **External Video Output** ▸ pick the device. That is
the equivalent of RV's Present Mode — whatever is loaded is routed to the card
from the current position, and the transport (play, pause, seek, loop) drives
the card. A badge beside the title shows which device is live and whether it
is keeping up. Choose *Built-in Display* to release the card.

## Why it exists

A screening-room check means putting a sequence on the projector and watching
it run. Doing that with RV means signing into a paid seat to perform what is
fundamentally a playback test. MaidenPlayer already opens EXR and DPX sequences
and needs no account; this is the missing output.

## How it works

```
EXR / DPX / ProRes → ffmpeg (v210, 10-bit 4:2:2) → sdi-out → DeckLink → SDI
                                                      ↑
                                          control lines on fd 3
```

**It never uses the H.264 proxy.** Image sequences are rendered to H.264 at
CRF 18 in `yuv420p` for the `<video>` element. Putting that on a VFX projector
would invite conclusions about a float render from an 8-bit, chroma-subsampled
picture, so SDI decodes the *original* frames straight to `v210` — the card's
native `bmdFormat10BitYUV` — and the proxy stays on the laptop screen.

**The clock lives in this process, not Electron's.** Electron's main thread
also runs IPC, menus, the auto-updater and garbage collection; a hard real-time
schedule sharing it drops frames. A separate process also means a driver fault
cannot take the player down mid-screening.

**Loop is ffmpeg's job.** `-stream_loop -1` re-reads the input seamlessly, so
the card sees one continuous stream and nothing has to hold a clip in RAM — at
4K DCI that would be 24 MB a frame. One trap: `-stream_loop` returns to where
*its input* began, so Loop switched on mid-clip would repeat from that point
forever. When playback is not at the start, the decode is two inputs joined by
the `concat` filter — the remainder from here, then the whole clip looping —
verified frame by frame (5…10, then 1…10, 1…10 …) on ffmpeg 6.1 and 9.0.

**A seek or a loop toggle restarts the session — gracefully.** The player
sends `stop`, waits for this process to exit (it stops the schedule, disables
the output and leaves on its own — 11 ms against the stub), and only then
starts the next one. Starting the next helper while the previous was still
dying made `EnableVideoOutput` fail with "another application is using this
device", and the badge went red. The helper also retries `EnableVideoOutput`
for up to two seconds, for whatever release delay the driver still has.

## What the helper does that is not obvious

- **The API is loaded at runtime**, by Blackmagic's own `DeckLinkAPIDispatch.cpp`,
  from `/Library/Frameworks/DeckLinkAPI.framework` — which Desktop Video
  installs. Nothing is linked and nothing is bundled. With no driver present
  `--list-devices` prints `[]` and exits 0: "no card" is a normal answer.
- **Frames complete on the SDK's thread.** Reading stdin inside that callback
  would stall the feed on a slow decoder, so a reader thread fills frames ahead
  into a ready queue and the callback only takes one that is already full.
- **An empty queue repeats the last frame** rather than going black. A repeated
  frame is a visible glitch; black is a lost picture. It is reported as
  `status:underrun` and the badge turns amber.
- **Row stride comes from the card** (`GetRowBytes`), never assumed. ffmpeg's
  v210 row is `((w+47)/48)*128` and DeckLink documents the same, but if they
  ever differ the copy goes row by row rather than shearing the image.
- **Pause holds the last frame** on the projector via `DisplayVideoFrameSync`.
  Frames scheduled but not yet shown are flushed by the card and lost; resume
  prerolls fresh ones, so a few frames skip on resume.
- **The cushion is deep on purpose.** `--buffer-frames` (default 24, one second
  at 24 fps) is how many frames sit on the card ahead of the clock; half are
  prerolled before it starts. The cost is RAM — about 570 MB at 4K DCI.
- **It speaks two generations of the driver.** The helper is compiled with SDK
  16.0's interface IDs, and Blackmagic gives an interface a *new* ID every time
  its vtable changes. A driver answers the IDs of its own generation and older,
  never newer — so on Desktop Video 14.5, `QueryInterface(IID_IDeckLinkOutput)`
  fails for *every* device and a working UltraStudio looks capture-only. That
  is exactly what happened on the first rig. So `IDeckLinkOutput`,
  `IDeckLinkVideoBuffer` and `IDeckLinkProfileAttributes` are each asked for
  by the 16.0 ID and then the 15.3.1-generation ID (Desktop Video 14.3 → 15.3.x).
  `IDeckLinkOutput` and the attributes are vtable-compatible and are used
  through the 16.0 type; `IDeckLinkVideoBuffer` is **not** (16.0 inserted
  `GetSize`), so the old object is driven through the old type. Drivers at
  14.2.1 or older have a different `IDeckLinkOutput` again and are refused
  with the version named, not attempted.

## CLI contract

`src/sdi.js` depends on this exactly.

### `sdi-out --list-devices`

A JSON array of output-capable devices and the **progressive** modes each can
drive at 10-bit YUV over SDI, as reported by the hardware. `[]` when Desktop
Video is absent.

```json
[{ "index": 0, "name": "UltraStudio 4K Mini", "model": "UltraStudio 4K Mini",
   "modes": [{ "id": "4d24", "name": "4K DCI 24p", "width": 4096, "height": 2160,
               "fps": 24, "fpsRational": "24000/1000" }, "..."] }]
```

`id` is the `BMDDisplayMode` FourCC as four characters. It is what `--mode`
takes, so the player never handles an SDK enum. `index` is the iterator
position and stays stable even when capture-only devices are skipped.

### `sdi-out --play --device N --mode XXXX [--buffer-frames 24]`

v210 frames on **stdin**, back to back. Control lines on **fd 3**: `play`,
`pause`, `stop`. Status lines on stderr, prefixed `status:` — `mode …`,
`playing`, `paused`, `underrun`, `recovered`, `eof frames=N`, `stopped`.

## Row stride — the trap

| Raster | Row bytes | naive `w/6*16` |
|---|---|---|
| 1920x1080 | 5,120 | 5,120 |
| 2048x1080 | **5,504** | 5,456 |
| 3840x2160 | 10,240 | 10,240 |
| 4096x2160 | **11,008** | 10,912 |

DCI widths are not multiples of 6, so rows pad to a 128-byte boundary. At 4K
DCI the naive figure is 207,360 bytes per frame short — a shear across the
projector. Verified byte for byte against ffmpeg's v210 encoder at eight widths.

## Decode speed is the real constraint

The card is fed by ffmpeg decoding the source in real time. Measured on a
2012-era Intel i7 with a float-EXR sequence:

| Target | Decode rate | Real time? |
|---|---|---|
| 2K DCI | 35.9 fps | yes, 1.5× headroom |
| 4K DCI | 20.6 fps | **no** — 1.2× too slow |

A modern machine is several times faster, but **4K float EXR at 24 fps needs a
box that can decode it at 24 fps sustained.** If the rig underruns, the answer
is not a bigger buffer — it is a pre-cache pass that decodes the sequence to
v210 on disk first and plays from there. That is the natural next step if the
room's machine cannot keep up.

Data rates the card must be fed, at 24 fps: 143 MB/s at 2K DCI, 531 MB/s at
UHD, 571 MB/s at 4K DCI. 4K needs 12G-SDI.

## Building

The DeckLink SDK 16.0 headers are **in the repo** at `sdk/` under Blackmagic's
redistribution licence, which every file carries. So:

```
scripts/build-sdi-out.sh          # macOS, universal, no CMake needed
```

produces `src/bin/sdi-out`. CI runs this on the macOS job, so the helper ships
in the installers. `MAIDENPLAYER_SDI_OUT` overrides the path for testing;
pointing it at `stub/sdi-out` fakes a device so the whole player-side pipeline
can be exercised without a card.

**Windows is not built yet.** The Windows SDK is `.idl` files that need `midl`
from the Visual Studio build tools to generate the headers; that is a
follow-up.

## When it says "No Blackmagic device found"

That one line has several distinct causes, so the app does not leave it there:

- The menu shows the helper's own one-line reason beneath it.
- **Playback ▸ External Video Output ▸ Output Diagnostics…** re-runs the
  enumeration and shows everything the helper said — framework present or
  missing, the installed Desktop Video version (read from the framework's
  Info.plist, so it works even when the code will not load), dyld's exact
  error if the API failed to load, whether the helper is running under
  Rosetta, how many devices the driver reported, and the exit code or signal.
  **Copy to Clipboard** and paste it back; that is the fastest way to a fix.

The same output from a terminal, on any build:

```
"/Applications/MaidenPlayer.app/Contents/Resources/app.asar.unpacked/src/bin/sdi-out" --list-devices; echo "exit=$?"
```

Reading the `diag:` lines:

| Line | Means |
|---|---|
| `helper-sdk 16.0` | The SDK this binary was compiled with. |
| `desktop-video-api 14.5` | The driver actually installed. |
| `driver-generation current` | Same generation; nothing special. |
| `driver-generation older-than-helper` | Driver is 14.3 → 15.3.x. Works — through the previous-generation interface IDs. |
| `driver-generation too-old` | Driver is 14.2.1 or older. Cannot be driven; update Desktop Video. |
| `device N "name" model="…" io=… duplex=… output=…` | One per device the driver reported, **listed or not**. `io` is the card's own capability (`capture`, `playback`, both); `duplex=inactive` means the sub-device is switched off in its Desktop Video Setup profile; `output=no` is the one to look at. |
| `devices-seen N` | How many the driver reported, so "found but unusable" is distinguishable from "not found". |

The one-line `sdi-out:` reason that follows picks the fix that matches: update
Desktop Video, swap in an output-capable device, or change the profile in
Desktop Video Setup.

How the API reaches the hardware, for reference: `DeckLinkAPI.framework` talks
to the driver over an XPC service, `com.blackmagic-design.desktopvideo.DeckLinkHardwareXPCService`.
Blackmagic's own samples are *sandboxed* and carry a mach-lookup exception for
it; MaidenPlayer is not sandboxed, so no exception is needed. A hardened,
notarized process needs `com.apple.security.cs.disable-library-validation` to
load a framework signed by another team — the helper carries it (verified in
the shipped 1.3.1 bundle).

## Verified

Without a card, against a stub honouring the contract above: 2K DCI mode
negotiated with the padded stride, exactly 24 frames at EOF, pause and resume
over the control channel, gapless loop past the clip end, zero underruns with
the default cushion. The real helper compiles universal against the SDK and
enumerates correctly on a machine with no driver.

**Playout itself has not been seen on a card.** There is no way to emulate an
SDI output; the first real test is on the rig.
