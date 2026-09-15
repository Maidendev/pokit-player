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
//
//  5. The driver on the rig may be OLDER than the SDK this was built with, and
//     Blackmagic gives an interface a new IID every time its vtable changes, so
//     an old driver answers E_NOINTERFACE to a new IID. That made a working
//     UltraStudio look "capture-only" on Desktop Video 14.5. The interfaces
//     that changed between 15.3.1 and 16.0 are therefore asked for by both
//     IIDs — see "Driver generations" below.
//
//  6. One source builds for macOS AND Windows. The API is COM on both, so
//     every DeckLink call is identical; what differs is how the API is
//     reached (a framework loaded at runtime vs. a registered COM server),
//     the string type it hands back (CFStringRef vs. BSTR), bool vs. BOOL in
//     out-parameters, and how a child sees the pipes its parent gave it. All
//     of that lives in the "Platform" section and nowhere else.

#if defined(_WIN32)
  #include <windows.h>
  #include <objbase.h>
  #include <fcntl.h>
  #include <io.h>
  #include "DeckLinkAPI_h.h"      // midl's output from sdk/Win/include/DeckLinkAPI.idl — see scripts/build-sdi-out-win.sh
  #include "DeckLinkAPIVersion.h"
#else
  #include "DeckLinkAPI.h"
  #include "DeckLinkAPIVersion.h"
  #include "DeckLinkAPIVideoOutput_v15_3_1.h"   // previous-generation IIDs and types; pulls in DeckLinkAPI_v15_3_1.h
  #include <CoreFoundation/CoreFoundation.h>
  #include <dlfcn.h>
  #include <fcntl.h>
  #include <sys/stat.h>
  #include <sys/sysctl.h>
  #include <unistd.h>
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
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

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

#ifndef STDMETHODCALLTYPE
  #define STDMETHODCALLTYPE            // Windows' calling-convention tag; nothing on macOS
#endif

#if defined(_WIN32)

using BmdString = BSTR;
using BmdBool   = BOOL;                // what the API fills in through an out-parameter

std::string bmdToStd(BSTR s) {
  if (!s) return {};
  const int len = static_cast<int>(::SysStringLen(s));
  const int bytes = ::WideCharToMultiByte(CP_UTF8, 0, s, len, nullptr, 0, nullptr, nullptr);
  if (bytes <= 0) return {};
  std::string out(static_cast<size_t>(bytes), '\0');
  ::WideCharToMultiByte(CP_UTF8, 0, s, len, out.data(), bytes, nullptr, nullptr);
  return out;
}
void bmdFree(BSTR s) { if (s) ::SysFreeString(s); }

// Desktop Video installs DeckLinkAPI64.dll and registers it as a COM server.
// CoCreateInstance failing with REGDB_E_CLASSNOTREG is the Windows form of
// "Desktop Video is not installed"; the code is kept for the diagnostics.
HRESULT gLastCreate = S_OK;
IDeckLinkIterator* createIterator() {
  IDeckLinkIterator* it = nullptr;
  gLastCreate = ::CoCreateInstance(CLSID_CDeckLinkIterator, nullptr, CLSCTX_ALL, IID_IDeckLinkIterator,
                                   reinterpret_cast<void**>(&it));
  return gLastCreate == S_OK ? it : nullptr;
}
IDeckLinkAPIInformation* createApiInformation() {
  IDeckLinkAPIInformation* info = nullptr;
  const HRESULT hr = ::CoCreateInstance(CLSID_CDeckLinkAPIInformation, nullptr, CLSCTX_ALL, IID_IDeckLinkAPIInformation,
                                        reinterpret_cast<void**>(&info));
  return hr == S_OK ? info : nullptr;
}

// The previous-generation IIDs, and the one previous-generation interface
// whose vtable differs (see "Driver generations"). The Mac build takes these
// from Blackmagic's compatibility headers. The Windows SDK ships the same as
// a separate .idl that does not import the main one, and midl's output for
// both in one file collides on the shared typedefs — so the three GUIDs are
// written out here instead, copied from DeckLinkAPI_v15_3_1.idl.
const IID IID_IDeckLinkOutput_v15_3_1            = { 0x1A8077F1, 0x9FE2, 0x4533, { 0x81, 0x47, 0x22, 0x94, 0x30, 0x5E, 0x25, 0x3F } };
const IID IID_IDeckLinkVideoBuffer_v15_3_1       = { 0xCCB4B64A, 0x5C86, 0x4E02, { 0xB7, 0x78, 0x88, 0x5D, 0x35, 0x27, 0x09, 0xFE } };
const IID IID_IDeckLinkProfileAttributes_v15_3_1 = { 0x17D4BF8E, 0x4911, 0x473A, { 0x80, 0xA0, 0x73, 0x1C, 0xF6, 0xFF, 0x34, 0x5B } };

struct IDeckLinkVideoBuffer_v15_3_1 : public IUnknown {
  virtual HRESULT STDMETHODCALLTYPE GetBytes(void** buffer) = 0;
  virtual HRESULT STDMETHODCALLTYPE StartAccess(BMDBufferAccessFlags flags) = 0;
  virtual HRESULT STDMETHODCALLTYPE EndAccess(BMDBufferAccessFlags flags) = 0;
};

// A child of Node sees the extra pipe its parent opened as CRT fd 3 — libuv
// hands the handle table over in STARTUPINFO, and the CRT reads it — so the
// same fd numbers work here as on POSIX. _get_osfhandle on a fd that is NOT
// there would trip the CRT's invalid-parameter handler, whose default is to
// end the process; main() installs a quiet one first.
FILE* fdOpenRead(int fd) { return ::_fdopen(fd, "r"); }
bool  fdExists(int fd)   { return ::_get_osfhandle(fd) != -1; }

#else

using BmdString = CFStringRef;
using BmdBool   = bool;

std::string bmdToStd(CFStringRef s) {
  if (!s) return {};
  const CFIndex max = CFStringGetMaximumSizeForEncoding(CFStringGetLength(s), kCFStringEncodingUTF8) + 1;
  std::string out(static_cast<size_t>(max), '\0');
  if (!CFStringGetCString(s, out.data(), max, kCFStringEncodingUTF8)) return {};
  out.resize(std::strlen(out.c_str()));
  return out;
}
void bmdFree(CFStringRef s) { if (s) CFRelease(s); }

IDeckLinkIterator*       createIterator()       { return CreateDeckLinkIteratorInstance(); }
IDeckLinkAPIInformation* createApiInformation() { return CreateDeckLinkAPIInformationInstance(); }

FILE* fdOpenRead(int fd) { return ::fdopen(fd, "r"); }
bool  fdExists(int fd)   { return ::fcntl(fd, F_GETFD) != -1; }

#endif

/** A string the API hands back, released when this goes out of scope. */
struct BmdStr {
  BmdString s = nullptr;
  ~BmdStr() { bmdFree(s); }
  BmdString* out() { return &s; }
  std::string str() const { return bmdToStd(s); }
};

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
#if defined(_WIN32)
    // _read takes an unsigned count; a 4K frame is 24 MB, well inside it.
    const int got = ::_read(fd, p, static_cast<unsigned>(std::min<size_t>(n, 1u << 30)));
#else
    const ssize_t got = ::read(fd, p, n);
#endif
    if (got <= 0) return false;
    p += got;
    n -= static_cast<size_t>(got);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Driver generations
// ---------------------------------------------------------------------------
//
// This helper is compiled with SDK 16.0's IIDs. Desktop Video answers
// QueryInterface for the IIDs of its own generation and OLDER ones, never
// newer: a 14.5 driver has never heard of 16.0's IID_IDeckLinkOutput and says
// E_NOINTERFACE for every device, output-capable or not. Screening rooms pin
// Desktop Video to whatever their Resolve wants, so old drivers are the norm,
// not the exception.
//
// Between 15.3.1 and 16.0 the interfaces used here changed as follows:
//
//   IDeckLinkOutput            Same vtable (one parameter's pointer type was
//                              renamed). The 16.0 type is used through the
//                              old IID.
//   IDeckLinkVideoBuffer       16.0 INSERTED GetSize between GetBytes and
//                              StartAccess, so the old object has to be
//                              driven through the old type — FrameBytes does.
//   IDeckLinkProfileAttributes 16.0 only APPENDED a method; the 16.0 type
//                              reads the old object.
//
// The generation before that (IDeckLinkOutput_v14_2_1, Desktop Video 14.2.1
// and older) has a different vtable again and no IDeckLinkVideoBuffer at all.
// It is not attempted; the diagnostics name the installed version instead.

// The oldest driver this helper can drive: the first release after 14.2.1.
// Packed like BLACKMAGIC_DECKLINK_API_VERSION, 0xMMmmpp00.
constexpr int64_t kOldestDrivableApi = 0x0E020200;
int64_t gInstalledApi = 0;             // packed; 0 when the API is not loaded
std::string gInstalledApiString;       // e.g. "14.5", for messages

/** Read the installed API version once. Both stay 0/empty when it is not loaded. */
void readInstalledApiVersion() {
  if (gInstalledApi) return;
  if (IDeckLinkAPIInformation* info = createApiInformation()) {
    int64_t v = 0;
    if (info->GetInt(BMDDeckLinkAPIVersion, &v) == S_OK) gInstalledApi = v;
    BmdStr s;
    if (info->GetString(BMDDeckLinkAPIVersion, s.out()) == S_OK) gInstalledApiString = s.str();
    info->Release();
  }
}

bool driverOlderThanHelper() { return gInstalledApi != 0 && gInstalledApi < BLACKMAGIC_DECKLINK_API_VERSION; }
bool driverTooOldToDrive()   { return gInstalledApi != 0 && gInstalledApi < kOldestDrivableApi; }

/**
 * IDeckLink -> IDeckLinkOutput, asking with this SDK's IID first and then the
 * previous generation's. NULL when the device truly has no output — or when
 * the driver predates both IIDs, which driverTooOldToDrive() tells apart.
 */
IDeckLinkOutput* queryOutput(IDeckLink* dl, const char** generation = nullptr) {
  void* p = nullptr;
  if (dl->QueryInterface(IID_IDeckLinkOutput, &p) == S_OK && p) {
    if (generation) *generation = "16.0";
    return static_cast<IDeckLinkOutput*>(p);
  }
  p = nullptr;
  if (dl->QueryInterface(IID_IDeckLinkOutput_v15_3_1, &p) == S_OK && p) {
    if (generation) *generation = "15.3.1-compatible";
    return static_cast<IDeckLinkOutput*>(p);
  }
  return nullptr;
}

/** A frame's pixel buffer, through whichever generation of interface the driver hands out. */
class FrameBytes {
 public:
  ~FrameBytes() {
    if (cur_) cur_->Release();
    if (old_) old_->Release();
  }
  bool open(IDeckLinkVideoFrame* f) {
    void* p = nullptr;
    if (f->QueryInterface(IID_IDeckLinkVideoBuffer, &p) == S_OK && p) {
      cur_ = static_cast<IDeckLinkVideoBuffer*>(p);
      return true;
    }
    p = nullptr;
    if (f->QueryInterface(IID_IDeckLinkVideoBuffer_v15_3_1, &p) == S_OK && p) {
      old_ = static_cast<IDeckLinkVideoBuffer_v15_3_1*>(p);
      return true;
    }
    return false;
  }
  HRESULT StartAccess(BMDBufferAccessFlags fl) { return cur_ ? cur_->StartAccess(fl) : old_->StartAccess(fl); }
  HRESULT GetBytes(void** bytes)               { return cur_ ? cur_->GetBytes(bytes)  : old_->GetBytes(bytes); }
  HRESULT EndAccess(BMDBufferAccessFlags fl)   { return cur_ ? cur_->EndAccess(fl)    : old_->EndAccess(fl); }

 private:
  IDeckLinkVideoBuffer* cur_ = nullptr;
  IDeckLinkVideoBuffer_v15_3_1* old_ = nullptr;
};

/**
 * What a device can do, from its profile attributes. Fields keep their
 * defaults when the driver will not say.
 */
struct DeviceCaps {
  bool known = false;                    // VideoIOSupport was reported
  bool capture = false, playback = false;
  int64_t duplex = 0;                    // BMDDuplexMode FourCC, 0 if not reported
};

DeviceCaps queryCaps(IDeckLink* dl) {
  DeviceCaps c;
  void* p = nullptr;
  if (dl->QueryInterface(IID_IDeckLinkProfileAttributes, &p) != S_OK || !p) {
    p = nullptr;
    if (dl->QueryInterface(IID_IDeckLinkProfileAttributes_v15_3_1, &p) != S_OK || !p) return c;
  }
  auto* attrs = static_cast<IDeckLinkProfileAttributes*>(p);
  int64_t io = 0;
  if (attrs->GetInt(BMDDeckLinkVideoIOSupport, &io) == S_OK) {
    c.known = true;
    c.capture  = (io & bmdDeviceSupportsCapture)  != 0;
    c.playback = (io & bmdDeviceSupportsPlayback) != 0;
  }
  attrs->GetInt(BMDDeckLinkDuplex, &c.duplex);
  attrs->Release();
  return c;
}

std::string duplexName(int64_t d) {
  switch (d) {
    case bmdDuplexFull:     return "full";
    case bmdDuplexHalf:     return "half";
    case bmdDuplexSimplex:  return "simplex";
    case bmdDuplexInactive: return "inactive";
    default:                return d ? fourccToString(uint32_t(d)) : "unreported";
  }
}

// ---------------------------------------------------------------------------
// --list-devices
// ---------------------------------------------------------------------------

/**
 * Say WHY there are no devices, in machine-readable lines on stderr, always.
 *
 * "No device found" is the one symptom every distinct failure shares — the
 * framework missing, the framework present but refusing to load, the API up
 * but the driver reporting nothing — and the app cannot tell them apart from
 * an empty list. These lines are what the Output Diagnostics dialog shows.
 */
void emitDiagnostics(bool apiLoaded) {
#if defined(_WIN32)
  // Is the COM server registered, and which DLL is it? The registry says so
  // without loading anything — the same role the framework's Info.plist
  // plays on macOS — and the DLL's file version IS the Desktop Video version.
  static const char* kInproc = "CLSID\\{BA6C6F44-6DA5-4DCE-94AA-EE2D1372A676}\\InprocServer32";   // CDeckLinkIterator
  char dll[MAX_PATH] = { 0 };
  DWORD sz = sizeof dll;
  const bool present = ::RegGetValueA(HKEY_CLASSES_ROOT, kInproc, nullptr, RRF_RT_REG_SZ, nullptr, dll, &sz) == ERROR_SUCCESS;
  if (present) std::fprintf(stderr, "diag:com-server registered %s\n", dll);
  else         std::fprintf(stderr, "diag:com-server not-registered\n");

  if (present) {
    DWORD handle = 0;
    if (const DWORD vsz = ::GetFileVersionInfoSizeA(dll, &handle)) {
      std::vector<uint8_t> buf(vsz);
      VS_FIXEDFILEINFO* ffi = nullptr;
      UINT flen = 0;
      if (::GetFileVersionInfoA(dll, 0, vsz, buf.data()) &&
          ::VerQueryValueA(buf.data(), "\\", reinterpret_cast<void**>(&ffi), &flen) && ffi) {
        std::fprintf(stderr, "diag:desktop-video-installed %u.%u.%u (build %u)\n",
                     unsigned(HIWORD(ffi->dwFileVersionMS)), unsigned(LOWORD(ffi->dwFileVersionMS)),
                     unsigned(HIWORD(ffi->dwFileVersionLS)), unsigned(LOWORD(ffi->dwFileVersionLS)));
      }
    }
  }

  if (present && !apiLoaded)
    std::fprintf(stderr, "diag:cocreate failed 0x%08lx (the server is registered but would not load)\n",
                 static_cast<unsigned long>(gLastCreate));
#else
  static const char* kFramework = "/Library/Frameworks/DeckLinkAPI.framework";
  struct stat st;
  const bool present = (::stat(kFramework, &st) == 0);
  std::fprintf(stderr, "diag:framework %s\n", present ? "present" : "missing");

  if (present) {
    // The framework's Info.plist names the installed Desktop Video version
    // WITHOUT loading any code, so this works even when the code won't load —
    // which is exactly when a version mismatch is the thing worth knowing.
    CFURLRef url = CFURLCreateWithFileSystemPath(kCFAllocatorDefault, CFSTR("/Library/Frameworks/DeckLinkAPI.framework"), kCFURLPOSIXPathStyle, true);
    if (url) {
      if (CFBundleRef b = CFBundleCreate(kCFAllocatorDefault, url)) {
        auto* ver = static_cast<CFStringRef>(CFBundleGetValueForInfoDictionaryKey(b, CFSTR("CFBundleShortVersionString")));
        auto* build = static_cast<CFStringRef>(CFBundleGetValueForInfoDictionaryKey(b, CFSTR("CFBundleVersion")));
        std::fprintf(stderr, "diag:desktop-video-installed %s (build %s)\n",
                     ver ? bmdToStd(ver).c_str() : "?", build ? bmdToStd(build).c_str() : "?");
        CFRelease(b);
      }
      CFRelease(url);
    }
  }

  if (present && !apiLoaded) {
    // The SDK's dispatch swallows the loader error. Ask dyld directly so the
    // real reason — wrong architecture, code-signing refusal, a missing
    // dependency — is in the log, not guessed at.
    void* h = ::dlopen("/Library/Frameworks/DeckLinkAPI.framework/DeckLinkAPI", RTLD_NOW);
    if (h) std::fprintf(stderr, "diag:dlopen ok (the framework loads, but the entry points did not resolve)\n");
    else   std::fprintf(stderr, "diag:dlopen failed: %s\n", ::dlerror());
  }
#endif

  readInstalledApiVersion();
  if (gInstalledApi) std::fprintf(stderr, "diag:desktop-video-api %s\n", gInstalledApiString.c_str());
  else               std::fprintf(stderr, "diag:desktop-video-api unavailable\n");

  // The SDK this binary was compiled with, beside the driver it found. When
  // the driver is the older of the two its interfaces are asked for by their
  // previous-generation IIDs (see "Driver generations"); older than THAT and
  // nothing can be driven, which is said here rather than left to look like a
  // capture-only card.
  std::fprintf(stderr, "diag:helper-sdk %s\n", BLACKMAGIC_DECKLINK_API_VERSION_STRING);
  if (driverTooOldToDrive())
    std::fprintf(stderr, "diag:driver-generation too-old (Desktop Video %s predates the interfaces this build can use; update it to %s or newer)\n",
                 gInstalledApiString.c_str(), BLACKMAGIC_DECKLINK_API_VERSION_STRING);
  else if (driverOlderThanHelper())
    std::fprintf(stderr, "diag:driver-generation older-than-helper (Desktop Video %s < SDK %s; using previous-generation interface IDs)\n",
                 gInstalledApiString.c_str(), BLACKMAGIC_DECKLINK_API_VERSION_STRING);
  else if (gInstalledApi)
    std::fprintf(stderr, "diag:driver-generation current\n");
#if defined(__arm64__)
  std::fprintf(stderr, "diag:helper-arch arm64\n");
#elif defined(_WIN32)
  std::fprintf(stderr, "diag:helper-arch x86_64\n");
#else
  // An x86_64 slice on an Apple Silicon Mac means Rosetta — which happens
  // when the Intel build of the app is installed there, because a translated
  // parent spawns translated children. Worth knowing before blaming the card.
  int translated = 0; size_t sz = sizeof translated;
  if (::sysctlbyname("sysctl.proc_translated", &translated, &sz, nullptr, 0) == 0 && translated == 1)
    std::fprintf(stderr, "diag:helper-arch x86_64 (under Rosetta on Apple Silicon)\n");
  else
    std::fprintf(stderr, "diag:helper-arch x86_64\n");
#endif
  std::fflush(stderr);
}

int listDevices() {
  IDeckLinkIterator* it = createIterator();
  emitDiagnostics(it != nullptr);
  if (!it) {
#if defined(_WIN32)
    if (gLastCreate == REGDB_E_CLASSNOTREG)
      fail("Desktop Video is not installed (the DeckLink COM server is not registered), so there are no devices to list");
    else
      fail("Desktop Video is installed, but its API could not be loaded — see the diag lines above for the COM error");
#else
    struct stat st;
    if (::stat("/Library/Frameworks/DeckLinkAPI.framework", &st) == 0)
      fail("Desktop Video is installed, but its API could not be loaded — see the diag lines above for dyld's reason");
    else
      fail("Desktop Video is not installed (no DeckLinkAPI.framework), so there are no devices to list");
#endif
    std::printf("[]\n");
    return 0;
  }

  std::printf("[");
  IDeckLink* dl = nullptr;
  int index = 0;      // iterator position — what --device takes
  int listed = 0;
  bool first = true;
  // Why each skipped device was skipped, for the one-line reason at the end.
  bool sawCaptureOnly = false, sawInactive = false, sawUnexplained = false;

  while (it->Next(&dl) == S_OK) {
    std::string name, model;
    { BmdStr s; if (dl->GetDisplayName(s.out()) == S_OK) name = s.str(); }
    { BmdStr s; if (dl->GetModelName(s.out()) == S_OK)   model = s.str(); }

    // Capture-only devices have no output interface and are skipped, but the
    // index still advances so it stays a stable iterator position.
    const char* generation = "none";
    IDeckLinkOutput* out = queryOutput(dl, &generation);
    const DeviceCaps caps = queryCaps(dl);

    // Every device the driver reports gets a line, output or not — the one
    // that is skipped is the one somebody is standing in front of.
    std::fprintf(stderr, "diag:device %d \"%s\" model=\"%s\" io=%s duplex=%s output=%s\n",
                 index, name.c_str(), model.c_str(),
                 !caps.known ? "unreported"
                   : (caps.capture && caps.playback) ? "capture+playback"
                   : caps.playback ? "playback"
                   : caps.capture ? "capture" : "none",
                 duplexName(caps.duplex).c_str(),
                 out ? generation : "no");

    if (out) {
      ++listed;
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
            BMDDisplayMode actual{};     // BMDDisplayMode is an enum on Windows, an integer on macOS
            BmdBool supported = false;
            const HRESULT hr = out->DoesSupportVideoMode(
                bmdVideoConnectionSDI, dm->GetDisplayMode(), kPixelFormat,
                bmdNoVideoOutputConversion, bmdSupportedVideoModeDefault, &actual, &supported);
            if (hr == S_OK && supported) {
              BMDTimeValue dur = 0;
              BMDTimeScale scale = 0;
              dm->GetFrameRate(&dur, &scale);
              std::string mname;
              { BmdStr s; if (dm->GetName(s.out()) == S_OK) mname = s.str(); }
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
    } else if (caps.known && !caps.playback) {
      sawCaptureOnly = true;
    } else if (caps.duplex == bmdDuplexInactive) {
      sawInactive = true;
    } else {
      sawUnexplained = true;
    }
    dl->Release();
    ++index;
  }
  it->Release();
  std::printf("]\n");
  std::fprintf(stderr, "diag:devices-seen %d (output-capable listed above)\n", index);

  if (index == 0) {
    fail("the API loaded but the driver reports 0 devices — check the device is powered, connected, and not held exclusively by another app");
  } else if (listed == 0) {
    // Seen but unusable. Say which kind of unusable — each has a different fix.
    const std::string sdk = BLACKMAGIC_DECKLINK_API_VERSION_STRING;
    if (driverTooOldToDrive())
      fail("Desktop Video " + gInstalledApiString + " is too old for this build — update Blackmagic Desktop Video to " + sdk +
           " or newer (free, at blackmagicdesign.com/support), then Refresh Devices");
    else if (sawCaptureOnly && !sawInactive && !sawUnexplained)
      fail("the connected device is capture-only (no SDI/HDMI output) — playout needs an output-capable device such as an "
           "UltraStudio Monitor 3G, UltraStudio 4K Mini, or a DeckLink with an output connector");
    else if (sawInactive)
      fail("the device's output is inactive in its current profile — in Blackmagic Desktop Video Setup, set the connector "
           "or profile to output (or full duplex), then Refresh Devices");
    else
      fail("a device was found but offers no output interface — see the diag:device line above; if Desktop Video is older than " +
           sdk + ", updating it is the first thing to try");
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Playout
// ---------------------------------------------------------------------------

class Player;

class OutputCallback : public IDeckLinkVideoOutputCallback {
 public:
  explicit OutputCallback(Player* p) : player_(p), refs_(1) {}
  HRESULT STDMETHODCALLTYPE ScheduledFrameCompleted(IDeckLinkVideoFrame* f, BMDOutputFrameCompletionResult r) override;
  HRESULT STDMETHODCALLTYPE ScheduledPlaybackHasStopped() override;

  // Answer for IUnknown and for the callback interface itself — the Windows
  // driver may ask before it will accept the callback. Anything else: no.
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, LPVOID* ppv) override {
    if (!ppv) return E_POINTER;
#if defined(_WIN32)
    const bool known = (iid == IID_IUnknown) || (iid == IID_IDeckLinkVideoOutputCallback);
#else
    const CFUUIDBytes unknown = CFUUIDGetUUIDBytes(IUnknownUUID);
    const bool known = std::memcmp(&iid, &unknown, sizeof iid) == 0 ||
                       std::memcmp(&iid, &IID_IDeckLinkVideoOutputCallback, sizeof iid) == 0;
#endif
    if (!known) { *ppv = nullptr; return E_NOINTERFACE; }
    *ppv = static_cast<IDeckLinkVideoOutputCallback*>(this);
    AddRef();
    return S_OK;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
  ULONG STDMETHODCALLTYPE Release() override {
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

    // A seek or a loop toggle in the player restarts this process, and the
    // driver can still be releasing the output from the helper that just
    // exited when this one asks for it. Nothing is on the card yet, so waiting
    // is invisible; only after two seconds is it really another application.
    HRESULT enabled = E_FAIL;
    for (int attempt = 0; attempt < 20; ++attempt) {
      enabled = out_->EnableVideoOutput(mode_->GetDisplayMode(), bmdVideoOutputFlagDefault);
      if (enabled == S_OK) break;
      if (attempt == 0)
        std::fprintf(stderr, "sdi-out: video output not yet available (0x%08x) — waiting for the device to be released\n",
                     static_cast<unsigned>(enabled));
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if (enabled != S_OK) {
      fail("could not enable video output — is another application already using this device?");
      return false;
    }

    std::string mname;
    { BmdStr s; if (mode_->GetName(s.out()) == S_OK) mname = s.str(); }
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
    FILE* ctl = (controlFd >= 0) ? fdOpenRead(controlFd) : nullptr;
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
    // Through whichever generation of buffer interface this driver has — the
    // 16.0 and 15.3.1 vtables differ, so this is not a plain QueryInterface.
    FrameBytes buf;
    if (!buf.open(f)) {
      fail("frame has no video buffer interface (neither this SDK's nor the previous generation's)");
      return false;
    }
    bool ok = false;
    if (buf.StartAccess(bmdBufferAccessWrite) == S_OK) {
      void* bytes = nullptr;
      if (buf.GetBytes(&bytes) == S_OK && bytes) {
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
      buf.EndAccess(bmdBufferAccessWrite);
    }
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

HRESULT STDMETHODCALLTYPE OutputCallback::ScheduledFrameCompleted(IDeckLinkVideoFrame* f, BMDOutputFrameCompletionResult r) {
  player_->onFrameCompleted(f, r);
  return S_OK;
}
HRESULT STDMETHODCALLTYPE OutputCallback::ScheduledPlaybackHasStopped() {
  player_->onPlaybackStopped();
  return S_OK;
}

// ---------------------------------------------------------------------------
// --play
// ---------------------------------------------------------------------------

int play(int deviceIndex, const std::string& modeId, int controlFd) {
  IDeckLinkIterator* it = createIterator();
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

  readInstalledApiVersion();
  const char* generation = "none";
  IDeckLinkOutput* out = queryOutput(chosen, &generation);
  if (!out) {
    if (driverTooOldToDrive())
      fail("Desktop Video " + gInstalledApiString + " is too old for this build — update it to " +
           BLACKMAGIC_DECKLINK_API_VERSION_STRING + " or newer");
    else
      fail("that device has no video output");
    chosen->Release();
    return 1;
  }
  if (driverOlderThanHelper())
    std::fprintf(stderr, "diag:driver-generation older-than-helper (Desktop Video %s; output through %s interfaces)\n",
                 gInstalledApiString.c_str(), generation);

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

  BmdBool supported = false;
  BMDDisplayMode actual{};     // BMDDisplayMode is an enum on Windows, an integer on macOS
  if (out->DoesSupportVideoMode(bmdVideoConnectionSDI, static_cast<BMDDisplayMode>(want), kPixelFormat, bmdNoVideoOutputConversion,
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
#if defined(_WIN32)
  // Frames arrive on stdin as raw bytes; the CRT's default text mode would
  // rewrite 0x0A and stop at 0x1A. COM must be initialised before any
  // CoCreateInstance, and the DeckLink objects are free-threaded. The quiet
  // invalid-parameter handler is for fdExists(3) — see the Platform section.
  ::_setmode(::_fileno(stdin), _O_BINARY);
  ::_set_invalid_parameter_handler([](const wchar_t*, const wchar_t*, const wchar_t*, unsigned, uintptr_t) {});
  ::CoInitializeEx(nullptr, COINIT_MULTITHREADED);
#endif
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
    const int controlFd = fdExists(3) ? 3 : -1;
    return play(device, mode, controlFd);
  }

  usage();
  return 2;
}
