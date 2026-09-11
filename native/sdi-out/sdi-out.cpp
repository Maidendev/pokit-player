// sdi-out — schedule v210 frames from stdin onto a Blackmagic DeckLink or
// UltraStudio output, frame-accurately.
//
// The player decodes the source with ffmpeg straight to v210 (10-bit 4:2:2,
// the card's native bmdFormat10BitYUV) and pipes it here. This process owns
// the playback clock so that Electron's main thread — which also runs IPC,
// menus, the auto-updater and garbage collection — never has to hold a
// real-time schedule. See ../../src/sdi.js for the other half and README.md
// for the contract.
//
// Things here that are not obvious and matter:
//
//  1. The DeckLink API is loaded at RUNTIME by DeckLinkAPIDispatch.cpp from
//     /Library/Frameworks/DeckLinkAPI.framework, which Desktop Video installs.
//     Nothing is linked. With no driver present CreateDeckLinkIteratorInstance()
//     returns NULL, so --list-devices prints [] and exits 0 — "no card" is a
//     normal answer, not a failure.
//
//  2. Frames come back from the card OUT OF the SDK's own thread via
//     ScheduledFrameCompleted. Reading stdin inside that callback would stall
//     the card's feed on a slow decoder, so a reader thread fills frames ahead
//     into a ready queue and the callback only ever takes one that is already
//     full. If the queue is empty the completed frame is shown AGAIN rather
//     than letting the output go black: a repeated frame is a visible glitch,
//     black is a lost picture.
//
//  3. Row stride is taken from the card (GetRowBytes), never computed and
//     assumed. ffmpeg's v210 row is ((w+47)/48)*128 and DeckLink documents the
//     same for this format, but if they ever differ the copy goes row by row
//     with the shorter length rather than shearing the picture.
//
//  4. Pause holds the LAST frame on the projector via DisplayVideoFrameSync
//     after stopping the schedule, so a paused review does not drop to black.
//     Frames that were scheduled but not yet shown are flushed by the card and
//     lost; resume prerolls fresh ones. A few frames skip on resume — accepted.

#include "DeckLinkAPI.h"

#include <CoreFoundation/CoreFoundation.h>
#include <fcntl.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// Frames allocated on the card, and how many are scheduled before the clock
// starts. Deep on purpose: at 24 fps, 24 frames is one second of cushion
// against a disk hiccup while reading a 25 MB EXR, and the cost is RAM — about
// 570 MB at 4K DCI. --buffer-frames overrides it for a smaller machine.
int gPoolFrames = 24;
int prerollFrames() { return std::max(4, gPoolFrames / 2); }
constexpr BMDPixelFormat kPixelFormat = bmdFormat10BitYUV;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

std::string cfToStd(CFStringRef s) {
  if (!s) return {};
  const CFIndex max = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), kCFStringEncodingUTF8) + 1;
  std::string out(static_cast<size_t>(max), '\0');
  if (!CFStringGetCString(s, out.data(), max, kCFStringEncodingUTF8)) return {};
  out.resize(std::strlen(out.c_str()));
  return out;
}

std::string jsonEscape(const std::string& in) {
  std::string out;
  for (char c : in) {
    switch (c) {
      case '"':  out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n";  break;
      case '\r': out += "\\r";  break;
      case '\t': out += "\\t";  break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) continue;
        out += c;
    }
  }
  return out;
}

// BMDDisplayMode values are FourCCs ('4d24' is bmdMode4kDCI24). Passing them
// around as their four characters keeps the player free of SDK enums, and it
// is what --list-devices prints and --mode accepts.
std::string fourccToString(uint32_t v) {
  const char b[5] = { char(v >> 24), char(v >> 16), char(v >> 8), char(v), 0 };
  return std::string(b, 4);
}

uint32_t stringToFourcc(const std::string& s) {
  if (s.size() != 4) return 0;
  return (uint32_t(uint8_t(s[0])) << 24) | (uint32_t(uint8_t(s[1])) << 16)
       | (uint32_t(uint8_t(s[2])) << 8)  |  uint32_t(uint8_t(s[3]));
}

/** ffmpeg's v210 row stride. DeckLink documents the same for 10-bit YUV. */
long v210RowBytes(long width) { return ((width + 47) / 48) * 128; }

void status(const std::string& s) {
  std::fprintf(stderr, "status:%s\n", s.c_str());
  std::fflush(stderr);
}

void fail(const std::string& s) {
  std::fprintf(stderr, "sdi-out: %s\n", s.c_str());
  std::fflush(stderr);
}

/** Read exactly n bytes from fd. Returns false on EOF or error. */
bool readFully(int fd, void* dst, size_t n) {
  auto* p = static_cast<uint8_t*>(dst);
  while (n > 0) {
    const ssize_t got = ::read(fd, p, n);
    if (got <= 0) return false;
    p += got;
    n -= static_cast<size_t>(got);
  }
  return true;
}

// ---------------------------------------------------------------------------
// --list-devices
// ---------------------------------------------------------------------------

int listDevices() {
  IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
  if (!it) {
    // Not an error: the driver is simply not on this machine.
    fail("Desktop Video is not installed (no DeckLinkAPI.framework), so there are no devices to list");
    std::printf("[]\n");
    return 0;
  }

  std::printf("[");
  IDeckLink* dl = nullptr;
  int index = 0;      // iterator position — what --device takes
  bool first = true;

  while (it->Next(&dl) == S_OK) {
    IDeckLinkOutput* out = nullptr;
    // Capture-only devices have no output interface and are skipped, but the
    // index still advances so it stays a stable iterator position.
    if (dl->QueryInterface(IID_IDeckLinkOutput, reinterpret_cast<void**>(&out)) == S_OK && out) {
      std::string name, model;
      CFStringRef cf = nullptr;
      if (dl->GetDisplayName(&cf) == S_OK && cf) { name = cfToStd(cf); CFRelease(cf); cf = nullptr; }
      if (dl->GetModelName(&cf) == S_OK && cf)   { model = cfToStd(cf); CFRelease(cf); cf = nullptr; }

      std::printf("%s{\"index\":%d,\"name\":\"%s\",\"model\":\"%s\",\"modes\":[",
                  first ? "" : ",", index, jsonEscape(name).c_str(), jsonEscape(model).c_str());
      first = false;

      IDeckLinkDisplayModeIterator* mit = nullptr;
      bool firstMode = true;
      if (out->GetDisplayModeIterator(&mit) == S_OK && mit) {
        IDeckLinkDisplayMode* dm = nullptr;
        while (mit->Next(&dm) == S_OK) {
          // Progressive only — the player never produces fields — and only
          // modes this card can actually drive at 10-bit YUV over SDI. Asking
          // the hardware here is what lets the player stop guessing.
          if (dm->GetFieldDominance() == bmdProgressiveFrame) {
            BMDDisplayMode actual = 0;
            bool supported = false;
            const HRESULT hr = out->DoesSupportVideoMode(
                bmdVideoConnectionSDI, dm->GetDisplayMode(), kPixelFormat,
                bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actual, &supported);
            if (hr == S_OK && supported) {
              BMDTimeValue dur = 0;
              BMDTimeScale scale = 0;
              dm->GetFrameRate(&dur, &scale);
              std::string mname;
              if (dm->GetName(&cf) == S_OK && cf) { mname = cfToStd(cf); CFRelease(cf); cf = nullptr; }
              std::printf("%s{\"id\":\"%s\",\"name\":\"%s\",\"width\":%ld,\"height\":%ld,"
                          "\"fps\":%.6g,\"fpsRational\":\"%lld/%lld\"}",
                          firstMode ? "" : ",",
                          fourccToString(dm->GetDisplayMode()).c_str(), jsonEscape(mname).c_str(),
                          dm->GetWidth(), dm->GetHeight(),
                          dur ? double(scale) / double(dur) : 0.0,
                          static_cast<long long>(scale), static_cast<long long>(dur));
              firstMode = false;
            }
          }
          dm->Release();
        }
        mit->Release();
      }
      std::printf("]}");
      out->Release();
    }
    dl->Release();
    ++index;
  }
  it->Release();
  std::printf("]\n");
  return 0;
}

// ---------------------------------------------------------------------------
// Playout
// ---------------------------------------------------------------------------

class Player;

class OutputCallback : public IDeckLinkVideoOutputCallback {
 public:
  explicit OutputCallback(Player* p) : player_(p), refs_(1) {}
  HRESULT ScheduledFrameCompleted(IDeckLinkVideoFrame* f, BMDOutputFrameCompletionResult r) override;
  HRESULT ScheduledPlaybackHasStopped() override;

  HRESULT QueryInterface(REFIID, LPVOID*) override { return E_NOINTERFACE; }
  ULONG AddRef() override { return ++refs_; }
  ULONG Release() override {
    const ULONG r = --refs_;
    if (r == 0) delete this;
    return r;
  }

 private:
  Player* player_;
  std::atomic<ULONG> refs_;
};

class Player {
 public:
  Player(IDeckLinkOutput* out, IDeckLinkDisplayMode* mode) : out_(out), mode_(mode) {}

  ~Player() {
    if (callback_) { out_->SetScheduledFrameCompletionCallback(nullptr); callback_->Release(); }
    if (held_) held_->Release();
    for (auto* f : pool_) f->Release();
  }

  bool setup() {
    width_  = mode_->GetWidth();
    height_ = mode_->GetHeight();
    mode_->GetFrameRate(&frameDuration_, &timeScale_);
    ffRowBytes_ = v210RowBytes(width_);

    callback_ = new OutputCallback(this);
    if (out_->SetScheduledFrameCompletionCallback(callback_) != S_OK) {
      fail("could not install the frame completion callback");
      return false;
    }

    for (int i = 0; i < gPoolFrames; ++i) {
      IDeckLinkMutableVideoFrame* f = nullptr;
      if (out_->CreateVideoFrame(int32_t(width_), int32_t(height_), int32_t(ffRowBytes_),
                                 kPixelFormat, bmdFrameFlagDefault, &f) != S_OK || !f) {
        fail("could not allocate a video frame on the card");
        return false;
      }
      pool_.push_back(f);
      freeQ_.push_back(f);
    }

    // Stride sanity, once, from the card itself.
    cardRowBytes_ = pool_[0]->GetRowBytes();
    if (cardRowBytes_ != ffRowBytes_) {
      std::fprintf(stderr, "sdi-out: card row stride %ld differs from ffmpeg's %ld — copying row by row\n",
                   cardRowBytes_, ffRowBytes_);
    }

    if (out_->EnableVideoOutput(mode_->GetDisplayMode(), bmdVideoOutputFlagDefault) != S_OK) {
      fail("could not enable video output — is another application already using this device?");
      return false;
    }

    CFStringRef cf = nullptr;
    std::string mname;
    if (mode_->GetName(&cf) == S_OK && cf) { mname = cfToStd(cf); CFRelease(cf); }
    status("mode " + fourccToString(mode_->GetDisplayMode()) + " " + mname + " " +
           std::to_string(width_) + "x" + std::to_string(height_) +
           " rowbytes=" + std::to_string(cardRowBytes_) + " buffer=" + std::to_string(gPoolFrames));
    return true;
  }

  /** Main loop. Returns exit code. */
  int run(int controlFd) {
    reader_ = std::thread([this] { readerLoop(); });

    if (!startPlayback()) return 1;

    // Control lines on fd 3, when the player gave us one. Otherwise run to EOF.
    FILE* ctl = (controlFd >= 0) ? fdopen(controlFd, "r") : nullptr;
    std::thread control;
    if (ctl) {
      control = std::thread([this, ctl] {
        char line[256];
        while (std::fgets(line, sizeof line, ctl)) {
          std::string cmd(line);
          while (!cmd.empty() && (cmd.back() == '\n' || cmd.back() == '\r' || cmd.back() == ' ')) cmd.pop_back();
          handleCommand(cmd);
        }
        // Player closed the control pipe: treat as stop.
        handleCommand("stop");
      });
    }

    // Wait until playback has fully wound down.
    {
      std::unique_lock<std::mutex> lk(mu_);
      cv_.wait(lk, [this] { return finished_; });
    }

    if (control.joinable()) { if (ctl) { /* fgets returns on close */ } control.detach(); }
    if (reader_.joinable()) reader_.detach();   // blocked on stdin; process exit reclaims it
    out_->DisableVideoOutput();
    status("stopped");
    return 0;
  }

  // ---- called from the SDK thread ----

  void onFrameCompleted(IDeckLinkVideoFrame* completed, BMDOutputFrameCompletionResult result) {
    std::unique_lock<std::mutex> lk(mu_);
    if (result == bmdOutputFrameDropped)       ++dropped_;
    if (result == bmdOutputFrameDisplayedLate) ++late_;

    // Remember what is on screen so pause can hold it.
    if (result != bmdOutputFrameFlushed) {
      if (held_) held_->Release();
      held_ = completed;
      held_->AddRef();
    }

    if (!playing_) {
      // Flushed by a stop or pause: the frame is simply free again.
      freeQ_.push_back(static_cast<IDeckLinkMutableVideoFrame*>(completed));
      cv_.notify_all();
      return;
    }

    if (!readyQ_.empty()) {
      IDeckLinkMutableVideoFrame* next = readyQ_.front();
      readyQ_.pop_front();
      freeQ_.push_back(static_cast<IDeckLinkMutableVideoFrame*>(completed));
      scheduleLocked(next);
      cv_.notify_all();
      return;
    }

    if (eof_) {
      // Nothing more will arrive. Let the schedule drain and finish.
      uint32_t buffered = 0;
      out_->GetBufferedVideoFrameCount(&buffered);
      freeQ_.push_back(static_cast<IDeckLinkMutableVideoFrame*>(completed));
      if (buffered == 0) {
        playing_ = false;
        lk.unlock();
        out_->StopScheduledPlayback(0, nullptr, timeScale_);
        lk.lock();
        status("eof frames=" + std::to_string(totalScheduled_));
        finished_ = true;
      }
      cv_.notify_all();
      return;
    }

    // Underrun: the decoder has not delivered the next frame in time. Show
    // this one again rather than let the output go black.
    ++underrunTotal_;
    if (!inUnderrun_) { inUnderrun_ = true; status("underrun"); }
    scheduleLocked(static_cast<IDeckLinkMutableVideoFrame*>(completed));
  }

  void onPlaybackStopped() {
    std::lock_guard<std::mutex> lk(mu_);
    cv_.notify_all();
  }

 private:
  // ---- reader thread: stdin -> free frame -> ready queue ----
  void readerLoop() {
    std::vector<uint8_t> row(static_cast<size_t>(ffRowBytes_));
    for (;;) {
      IDeckLinkMutableVideoFrame* f = nullptr;
      {
        std::unique_lock<std::mutex> lk(mu_);
        cv_.wait(lk, [this] { return !freeQ_.empty() || finished_; });
        if (finished_) return;
        f = freeQ_.front();
        freeQ_.pop_front();
      }

      if (!fillFrame(f, row)) {
        std::lock_guard<std::mutex> lk(mu_);
        freeQ_.push_back(f);
        eof_ = true;
        cv_.notify_all();
        // If playback is idle (paused at EOF, or never started), finish now.
        if (!playing_) { finished_ = true; }
        return;
      }

      std::lock_guard<std::mutex> lk(mu_);
      readyQ_.push_back(f);
      if (inUnderrun_) { inUnderrun_ = false; status("recovered"); }
      cv_.notify_all();
    }
  }

  /** stdin -> frame. False on EOF. */
  bool fillFrame(IDeckLinkMutableVideoFrame* f, std::vector<uint8_t>& row) {
    IDeckLinkVideoBuffer* buf = nullptr;
    if (f->QueryInterface(IID_IDeckLinkVideoBuffer, reinterpret_cast<void**>(&buf)) != S_OK || !buf) {
      fail("frame has no video buffer interface");
      return false;
    }
    bool ok = false;
    if (buf->StartAccess(bmdBufferAccessWrite) == S_OK) {
      void* bytes = nullptr;
      if (buf->GetBytes(&bytes) == S_OK && bytes) {
        auto* dst = static_cast<uint8_t*>(bytes);
        if (cardRowBytes_ == ffRowBytes_) {
          ok = readFully(0, dst, static_cast<size_t>(ffRowBytes_) * static_cast<size_t>(height_));
        } else {
          ok = true;
          const size_t copy = static_cast<size_t>(std::min(cardRowBytes_, ffRowBytes_));
          for (long y = 0; y < height_ && ok; ++y) {
            ok = readFully(0, row.data(), static_cast<size_t>(ffRowBytes_));
            if (ok) std::memcpy(dst + y * cardRowBytes_, row.data(), copy);
          }
        }
      }
      buf->EndAccess(bmdBufferAccessWrite);
    }
    buf->Release();
    return ok;
  }

  // ---- scheduling (mu_ held) ----
  void scheduleLocked(IDeckLinkMutableVideoFrame* f) {
    const HRESULT hr = out_->ScheduleVideoFrame(f, totalScheduled_ * frameDuration_, frameDuration_, timeScale_);
    if (hr != S_OK) {
      fail("ScheduleVideoFrame failed");
      freeQ_.push_back(f);
      return;
    }
    ++totalScheduled_;
  }

  bool startPlayback() {
    // Preroll: wait until enough frames are decoded that the card has a
    // cushion, then schedule them all before the clock starts.
    std::unique_lock<std::mutex> lk(mu_);
    cv_.wait(lk, [this] { return int(readyQ_.size()) >= prerollFrames() || eof_ || finished_; });
    if (finished_) return false;
    if (readyQ_.empty()) {
      fail("no frames arrived on stdin");
      finished_ = true;
      return false;
    }
    totalScheduled_ = 0;
    while (!readyQ_.empty()) {
      IDeckLinkMutableVideoFrame* f = readyQ_.front();
      readyQ_.pop_front();
      scheduleLocked(f);
    }
    playing_ = true;
    lk.unlock();

    if (out_->StartScheduledPlayback(0, timeScale_, 1.0) != S_OK) {
      fail("StartScheduledPlayback failed");
      std::lock_guard<std::mutex> g(mu_);
      playing_ = false;
      finished_ = true;
      cv_.notify_all();
      return false;
    }
    status("playing");
    return true;
  }

  void pausePlayback() {
    IDeckLinkVideoFrame* hold = nullptr;
    {
      std::lock_guard<std::mutex> lk(mu_);
      if (!playing_) return;
      playing_ = false;
      hold = held_;
      if (hold) hold->AddRef();
    }
    out_->StopScheduledPlayback(0, nullptr, timeScale_);
    // Keep the picture up rather than dropping to black.
    if (hold) { out_->DisplayVideoFrameSync(hold); hold->Release(); }
    status("paused");
  }

  void stopPlayback() {
    {
      std::lock_guard<std::mutex> lk(mu_);
      playing_ = false;
    }
    out_->StopScheduledPlayback(0, nullptr, timeScale_);
    std::lock_guard<std::mutex> lk(mu_);
    finished_ = true;
    cv_.notify_all();
  }

  void handleCommand(const std::string& cmd) {
    if (cmd == "play")       { startPlayback(); }
    else if (cmd == "pause") { pausePlayback(); }
    else if (cmd == "stop")  { stopPlayback(); }
    else if (!cmd.empty())   { fail("unknown control command '" + cmd + "'"); }
  }

  IDeckLinkOutput* out_;
  IDeckLinkDisplayMode* mode_;
  OutputCallback* callback_ = nullptr;

  long width_ = 0, height_ = 0;
  long ffRowBytes_ = 0, cardRowBytes_ = 0;
  BMDTimeValue frameDuration_ = 0;
  BMDTimeScale timeScale_ = 0;

  std::vector<IDeckLinkMutableVideoFrame*> pool_;
  std::deque<IDeckLinkMutableVideoFrame*> freeQ_;
  std::deque<IDeckLinkMutableVideoFrame*> readyQ_;
  IDeckLinkVideoFrame* held_ = nullptr;

  std::mutex mu_;
  std::condition_variable cv_;
  std::thread reader_;

  bool playing_ = false;
  bool eof_ = false;
  bool finished_ = false;
  bool inUnderrun_ = false;
  uint64_t totalScheduled_ = 0;
  uint64_t underrunTotal_ = 0, dropped_ = 0, late_ = 0;
};

HRESULT OutputCallback::ScheduledFrameCompleted(IDeckLinkVideoFrame* f, BMDOutputFrameCompletionResult r) {
  player_->onFrameCompleted(f, r);
  return S_OK;
}
HRESULT OutputCallback::ScheduledPlaybackHasStopped() {
  player_->onPlaybackStopped();
  return S_OK;
}

// ---------------------------------------------------------------------------
// --play
// ---------------------------------------------------------------------------

int play(int deviceIndex, const std::string& modeId, int controlFd) {
  IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
  if (!it) {
    fail("Desktop Video is not installed, so there is no device to play to");
    return 1;
  }

  IDeckLink* dl = nullptr;
  IDeckLink* chosen = nullptr;
  int index = 0;
  while (it->Next(&dl) == S_OK) {
    if (index == deviceIndex) { chosen = dl; }
    else dl->Release();
    ++index;
  }
  it->Release();
  if (!chosen) {
    fail("no device at index " + std::to_string(deviceIndex) + " (" + std::to_string(index) + " found)");
    return 1;
  }

  IDeckLinkOutput* out = nullptr;
  if (chosen->QueryInterface(IID_IDeckLinkOutput, reinterpret_cast<void**>(&out)) != S_OK || !out) {
    fail("that device has no video output");
    chosen->Release();
    return 1;
  }

  const uint32_t want = stringToFourcc(modeId);
  IDeckLinkDisplayMode* mode = nullptr;
  IDeckLinkDisplayModeIterator* mit = nullptr;
  std::string available;
  if (out->GetDisplayModeIterator(&mit) == S_OK && mit) {
    IDeckLinkDisplayMode* dm = nullptr;
    while (mit->Next(&dm) == S_OK) {
      if (!mode && dm->GetDisplayMode() == want) { mode = dm; }
      else { available += (available.empty() ? "" : " ") + fourccToString(dm->GetDisplayMode()); dm->Release(); }
    }
    mit->Release();
  }
  if (!mode) {
    fail("mode '" + modeId + "' is not offered by this device; it has: " + available);
    out->Release(); chosen->Release();
    return 1;
  }

  bool supported = false;
  BMDDisplayMode actual = 0;
  if (out->DoesSupportVideoMode(bmdVideoConnectionSDI, want, kPixelFormat, bmdNoVideoOutputConversion,
                                bmdSupportedVideoModeDefault, &actual, &supported) != S_OK || !supported) {
    fail("this device cannot output mode '" + modeId + "' as 10-bit YUV over SDI");
    mode->Release(); out->Release(); chosen->Release();
    return 1;
  }

  int rc = 1;
  {
    Player player(out, mode);
    if (player.setup()) rc = player.run(controlFd);
  }

  mode->Release();
  out->Release();
  chosen->Release();
  return rc;
}

void usage() {
  std::fprintf(stderr,
    "sdi-out — Blackmagic SDI output for MaidenPlayer\n"
    "\n"
    "  sdi-out --list-devices\n"
    "      JSON array of output-capable devices and the progressive modes each\n"
    "      can drive at 10-bit YUV over SDI. [] when Desktop Video is absent.\n"
    "\n"
    "  sdi-out --play --device N --mode XXXX [--buffer-frames 24]\n"
    "      Read v210 frames on stdin and schedule them to device N in display\n"
    "      mode XXXX (a four-character id from --list-devices). Control lines\n"
    "      on fd 3: play | pause | stop. Status lines on stderr: status:...\n"
    "      --buffer-frames sets the on-card cushion (default 24, min 4).\n");
}

}  // namespace

int main(int argc, const char* argv[]) {
  if (argc < 2) { usage(); return 2; }
  const std::string cmd = argv[1];

  if (cmd == "--list-devices") return listDevices();

  if (cmd == "--play") {
    int device = -1;
    std::string mode;
    for (int i = 2; i < argc; ++i) {
      const std::string a = argv[i];
      const bool has = (i + 1 < argc);
      if (a == "--device" && has)    device = std::atoi(argv[++i]);
      else if (a == "--mode" && has) mode = argv[++i];
      else if (a == "--buffer-frames" && has) gPoolFrames = std::max(4, std::atoi(argv[++i]));
      else { fail("unrecognised argument '" + a + "'"); return 2; }
    }
    if (device < 0 || mode.size() != 4) { usage(); return 2; }
    // fd 3 is the control channel if the parent opened one.
    const int controlFd = (fcntl(3, F_GETFD) != -1) ? 3 : -1;
    return play(device, mode, controlFd);
  }

  usage();
  return 2;
}
