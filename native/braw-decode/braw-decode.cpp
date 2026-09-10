// braw-decode — turn Blackmagic RAW into raw frames on stdout.
//
// FFmpeg has no Blackmagic RAW support at all, so MaidenPlayer cannot decode
// .braw the way it decodes everything else. This helper is the narrowest
// possible bridge: it uses Blackmagic's SDK to produce frames, writes them to
// stdout, and lets the player's existing ffmpeg → fMP4 → MediaSource pipeline
// do the rest. See ../../src/braw.js for the other half, and README.md for the
// CLI contract the two share.
//
// Three things here are not obvious and matter:
//
//  1. The SDK is ASYNCHRONOUS and completes jobs OUT OF ORDER. A player needs
//     frames in presentation order, so completed frames go into a reorder
//     buffer keyed by frame index and a writer drains it in sequence.
//
//  2. Writing to a pipe BLOCKS when the reader is slow, and that is the
//     backpressure the player relies on to keep decode from saturating its UI
//     thread. So the blocking write happens on its own thread, never inside an
//     SDK callback, where it would stall the decoder's worker pool.
//
//  3. Submission is bounded twice over — by jobs in flight and by how far
//     ahead of the writer it may run — otherwise a fast decoder buffers the
//     whole clip in RAM. At 6K, sixty frames is over a gigabyte.

#include "BlackmagicRawAPI.h"

#include <atomic>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace {

// How many read/decode jobs may be outstanding, and how far submission may run
// ahead of the writer. Small numbers: each queued 6K frame is ~76 MB at 16-bit
// RGB, so the window is the real memory ceiling.
constexpr int kMaxJobsInFlight = 4;
constexpr uint64_t kMaxFramesAhead = 8;

// ---------------------------------------------------------------------------
// Pixel formats
//
// The name on the left is an FFmpeg pixel format, because it is passed
// straight to ffmpeg's -pixel_format by src/braw.js. Keeping the mapping here
// means the player never has to know an SDK enum.
// ---------------------------------------------------------------------------
struct PixelFormat {
  const char* ffmpegName;
  BlackmagicRawResourceFormat sdkFormat;
  int bytesPerPixel;
};

constexpr PixelFormat kPixelFormats[] = {
  { "rgb48le",  blackmagicRawResourceFormatRGBU16,  6 },
  { "rgba64le", blackmagicRawResourceFormatRGBAU16, 8 },
  { "rgb24",    blackmagicRawResourceFormatRGBAU8,  4 },  // RGBA8; see note below
};

const PixelFormat* findPixelFormat(const std::string& name) {
  for (const auto& f : kPixelFormats)
    if (name == f.ffmpegName) return &f;
  return nullptr;
}

// 16-bit RGB by default: it keeps the full precision the format carries into
// the H.264 encode, and costs a third less bandwidth than RGBA by dropping an
// alpha channel that a camera original never uses.
const PixelFormat* kDefaultPixelFormat = &kPixelFormats[0];

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

struct CFStr {
  CFStringRef ref = nullptr;
  explicit CFStr(const char* s) { ref = CFStringCreateWithCString(nullptr, s, kCFStringEncodingUTF8); }
  ~CFStr() { if (ref) CFRelease(ref); }
  CFStr(const CFStr&) = delete;
  CFStr& operator=(const CFStr&) = delete;
};

/** Escape a string for embedding in the JSON that --info prints. */
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
        if (static_cast<unsigned char>(c) < 0x20) continue;  // drop controls
        out += c;
    }
  }
  return out;
}

/**
 * The SDK reports frame rate as a float, but FFmpeg needs the exact rational
 * or 23.976 drifts audibly out of sync over a long clip. Snap to the standard
 * broadcast rates; fall back to a 1/1000 approximation for anything exotic.
 */
std::string rationalForRate(float fps) {
  struct Entry { float rate; const char* rational; };
  static constexpr Entry kRates[] = {
    { 23.976f, "24000/1001" },  { 24.0f,  "24/1" },
    { 25.0f,   "25/1" },        { 29.97f, "30000/1001" },
    { 30.0f,   "30/1" },        { 47.952f, "48000/1001" },
    { 48.0f,   "48/1" },        { 50.0f,  "50/1" },
    { 59.94f,  "60000/1001" },  { 60.0f,  "60/1" },
    { 95.904f, "96000/1001" },  { 96.0f,  "96/1" },
    { 100.0f,  "100/1" },       { 119.88f, "120000/1001" },
    { 120.0f,  "120/1" },
  };
  for (const auto& e : kRates)
    if (std::fabs(fps - e.rate) < 0.02f) return e.rational;

  char buf[64];
  std::snprintf(buf, sizeof buf, "%lld/1000", static_cast<long long>(std::lround(fps * 1000.0f)));
  return buf;
}

/** Render a metadata Variant as a JSON value, or "" if it is not worth one. */
std::string variantToJson(const Variant& v) {
  char buf[64];
  switch (v.vt) {
    case blackmagicRawVariantTypeU8:      std::snprintf(buf, sizeof buf, "%u", v.uiVal);  return buf;
    case blackmagicRawVariantTypeS16:     std::snprintf(buf, sizeof buf, "%d", v.iVal);   return buf;
    case blackmagicRawVariantTypeU16:     std::snprintf(buf, sizeof buf, "%u", v.uiVal);  return buf;
    case blackmagicRawVariantTypeS32:     std::snprintf(buf, sizeof buf, "%d", v.intVal); return buf;
    case blackmagicRawVariantTypeU32:     std::snprintf(buf, sizeof buf, "%u", v.uintVal);return buf;
    case blackmagicRawVariantTypeFloat32: std::snprintf(buf, sizeof buf, "%.6g", v.fltVal); return buf;
    case blackmagicRawVariantTypeFloat64: std::snprintf(buf, sizeof buf, "%.6g", v.dblVal); return buf;
    case blackmagicRawVariantTypeString:  return "\"" + jsonEscape(cfToStd(v.bstrVal)) + "\"";
    default: return {};   // arrays and empties are not useful to the player
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the SDK factory.
 *
 * The header also declares CreateBlackmagicRawFactoryInstanceFromPath and
 * ...FromExeRelativePath, and the SDK's own samples call them — but the macOS
 * framework does NOT export either one (`nm -gU` lists only the no-argument
 * form). So the library has to be found by the normal dynamic loader instead,
 * which is why this binary links the framework and carries an @loader_path
 * rpath: the framework is shipped beside the executable in src/bin, and the
 * loader picks it up from there.
 *
 * The framework then finds its own inner decoders — DecoderMetal,
 * DecoderOpenCL, the AVX instruction-set helpers — relative to itself, so the
 * whole bundle has to be copied, not just the top-level binary.
 */
IBlackmagicRawFactory* createFactory() {
  return CreateBlackmagicRawFactoryInstance();
}

// ---------------------------------------------------------------------------
// Ordered frame writer
// ---------------------------------------------------------------------------

/**
 * Collects decoded frames from the SDK's callback threads and writes them to
 * stdout in frame order.
 */
class FrameWriter {
 public:
  FrameWriter(uint64_t firstFrame, uint64_t lastFrame, size_t expectedBytes)
      : next_(firstFrame), last_(lastFrame), expectedBytes_(expectedBytes) {}

  /** Called from an SDK callback thread. Never blocks on the pipe. */
  void deliver(uint64_t index, const void* data, size_t bytes) {
    std::vector<uint8_t> copy(static_cast<const uint8_t*>(data),
                              static_cast<const uint8_t*>(data) + bytes);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      ready_.emplace(index, std::move(copy));
    }
    cv_.notify_all();
  }

  void fail(const std::string& why) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (error_.empty()) error_ = why;
    }
    cv_.notify_all();
  }

  /** Runs on the main thread until every frame is written or something fails. */
  bool drain() {
    while (next_ <= last_) {
      std::vector<uint8_t> frame;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait(lock, [&] { return !error_.empty() || ready_.count(next_) > 0; });
        if (!error_.empty()) {
          std::fprintf(stderr, "braw-decode: %s\n", error_.c_str());
          return false;
        }
        frame = std::move(ready_[next_]);
        ready_.erase(next_);
      }

      if (expectedBytes_ && frame.size() != expectedBytes_) {
        std::fprintf(stderr,
                     "braw-decode: frame %llu is %zu bytes, expected %zu — "
                     "the pixel format reported by --info does not match the decode\n",
                     static_cast<unsigned long long>(next_), frame.size(), expectedBytes_);
        return false;
      }

      // The blocking write. A full pipe stalls here, which is exactly the
      // backpressure the player wants, and it stalls the writer only.
      if (std::fwrite(frame.data(), 1, frame.size(), stdout) != frame.size()) {
        // A closed pipe is normal: the player kills us on stop and on seek.
        std::fprintf(stderr, "braw-decode: stdout closed at frame %llu\n",
                     static_cast<unsigned long long>(next_));
        return false;
      }

      ++next_;
      cv_.notify_all();   // submission may be waiting on the window
    }
    std::fflush(stdout);
    return true;
  }

  /** How far ahead of the writer submission has run. */
  uint64_t writePosition() {
    std::lock_guard<std::mutex> lock(mutex_);
    return next_;
  }

  bool failed() {
    std::lock_guard<std::mutex> lock(mutex_);
    return !error_.empty();
  }

  std::mutex mutex_;
  std::condition_variable cv_;

 private:
  std::map<uint64_t, std::vector<uint8_t>> ready_;
  uint64_t next_;
  uint64_t last_;
  size_t expectedBytes_;
  std::string error_;
};

// ---------------------------------------------------------------------------
// SDK callback
// ---------------------------------------------------------------------------

struct JobContext { uint64_t frameIndex; };

class DecodeCallback : public IBlackmagicRawCallback {
 public:
  DecodeCallback(FrameWriter* writer, BlackmagicRawResourceFormat format,
                 std::atomic<int>* jobsInFlight)
      : writer_(writer), format_(format), jobsInFlight_(jobsInFlight) {}

  void ReadComplete(IBlackmagicRawJob* readJob, HRESULT result, IBlackmagicRawFrame* frame) override {
    auto* ctx = static_cast<JobContext*>(nullptr);
    readJob->GetUserData(reinterpret_cast<void**>(&ctx));

    IBlackmagicRawJob* decodeJob = nullptr;
    if (result == S_OK) result = frame->SetResourceFormat(format_);
    if (result == S_OK) result = frame->CreateJobDecodeAndProcessFrame(nullptr, nullptr, &decodeJob);
    if (result == S_OK) result = decodeJob->SetUserData(ctx);
    if (result == S_OK) result = decodeJob->Submit();

    if (result != S_OK) {
      if (decodeJob) decodeJob->Release();
      writer_->fail("failed to decode frame " +
                    std::to_string(ctx ? ctx->frameIndex : 0));
      delete ctx;
      --*jobsInFlight_;   // this job will never reach ProcessComplete
    }
    readJob->Release();
  }

  void ProcessComplete(IBlackmagicRawJob* job, HRESULT result,
                       IBlackmagicRawProcessedImage* image) override {
    auto* ctx = static_cast<JobContext*>(nullptr);
    job->GetUserData(reinterpret_cast<void**>(&ctx));
    const uint64_t index = ctx ? ctx->frameIndex : 0;

    void* resource = nullptr;
    uint32_t sizeBytes = 0;
    if (result == S_OK) result = image->GetResource(&resource);
    if (result == S_OK) result = image->GetResourceSizeBytes(&sizeBytes);

    if (result == S_OK && resource && sizeBytes) {
      writer_->deliver(index, resource, sizeBytes);
    } else {
      writer_->fail("failed to read decoded pixels for frame " + std::to_string(index));
    }

    delete ctx;
    job->Release();
    --*jobsInFlight_;
  }

  void DecodeComplete(IBlackmagicRawJob*, HRESULT) override {}
  void TrimProgress(IBlackmagicRawJob*, float) override {}
  void TrimComplete(IBlackmagicRawJob*, HRESULT) override {}
  void SidecarMetadataParseWarning(IBlackmagicRawClip*, CFStringRef, uint32_t, CFStringRef) override {}
  void SidecarMetadataParseError(IBlackmagicRawClip*, CFStringRef, uint32_t, CFStringRef) override {}
  void PreparePipelineComplete(void*, HRESULT) override {}

  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, LPVOID*) override { return E_NOTIMPL; }
  ULONG STDMETHODCALLTYPE AddRef() override { return 1; }
  ULONG STDMETHODCALLTYPE Release() override { return 1; }

 private:
  FrameWriter* writer_;
  BlackmagicRawResourceFormat format_;
  std::atomic<int>* jobsInFlight_;
};

// ---------------------------------------------------------------------------
// Opened clip, with everything --info reports
// ---------------------------------------------------------------------------

struct Clip {
  IBlackmagicRawFactory* factory = nullptr;
  IBlackmagicRaw* codec = nullptr;
  IBlackmagicRawClip* clip = nullptr;

  ~Clip() {
    if (clip) clip->Release();
    if (codec) codec->Release();
    if (factory) factory->Release();
  }

  bool open(const std::string& path) {
    factory = createFactory();
    if (!factory) {
      std::fprintf(stderr,
                   "braw-decode: could not load the Blackmagic RAW libraries. The "
                   "BlackmagicRawAPI framework must sit beside this executable.\n");
      return false;
    }
    if (factory->CreateCodec(&codec) != S_OK) {
      std::fprintf(stderr, "braw-decode: could not create the Blackmagic RAW codec\n");
      return false;
    }
    CFStr name(path.c_str());
    if (codec->OpenClip(name.ref, &clip) != S_OK) {
      std::fprintf(stderr, "braw-decode: could not open '%s' as a Blackmagic RAW clip\n", path.c_str());
      return false;
    }
    return true;
  }
};

// ---------------------------------------------------------------------------
// --info
// ---------------------------------------------------------------------------

int runInfo(const std::string& path, const PixelFormat& pf) {
  Clip c;
  if (!c.open(path)) return 1;

  uint32_t width = 0, height = 0;
  uint64_t frameCount = 0;
  float frameRate = 0.0f;
  c.clip->GetWidth(&width);
  c.clip->GetHeight(&height);
  c.clip->GetFrameRate(&frameRate);
  c.clip->GetFrameCount(&frameCount);

  std::string timecode;
  CFStringRef tc = nullptr;
  if (c.clip->GetTimecodeForFrame(0, &tc) == S_OK && tc) {
    timecode = cfToStd(tc);
    CFRelease(tc);
  }

  std::string cameraType;
  CFStringRef camera = nullptr;
  if (c.clip->GetCameraType(&camera) == S_OK && camera) {
    cameraType = cfToStd(camera);
    CFRelease(camera);
  }

  // Audio is optional: a clip recorded without it simply has no such interface.
  uint32_t channels = 0, sampleRate = 0, bitDepth = 0;
  uint64_t sampleCount = 0;
  bool hasAudio = false;
  IBlackmagicRawClipAudio* audio = nullptr;
  if (c.clip->QueryInterface(IID_IBlackmagicRawClipAudio, reinterpret_cast<void**>(&audio)) == S_OK && audio) {
    audio->GetAudioChannelCount(&channels);
    audio->GetAudioSampleRate(&sampleRate);
    audio->GetAudioBitDepth(&bitDepth);
    audio->GetAudioSampleCount(&sampleCount);
    hasAudio = channels > 0 && sampleCount > 0;
    audio->Release();
  }

  // Clip metadata. Collect it all, then pick — the key names were taken from
  // --dump-metadata against real camera files, not guessed.
  //
  // Note ISO and white balance are NOT here: they are per-FRAME metadata, so
  // reading them would mean submitting a frame read job on the probe path.
  // Probe latency is on the file-open path, so they are left out and reported
  // as absent rather than slowing every open.
  std::map<std::string, std::string> meta;
  IBlackmagicRawMetadataIterator* it = nullptr;
  if (c.clip->GetMetadataIterator(&it) == S_OK && it) {
    for (;;) {
      CFStringRef key = nullptr;
      if (it->GetKey(&key) != S_OK || !key) break;
      Variant v;
      VariantInit(&v);
      if (it->GetData(&v) == S_OK) {
        const std::string value = variantToJson(v);
        if (!value.empty()) meta[cfToStd(key)] = value;
      }
      VariantClear(&v);
      if (it->Next() != S_OK) break;
    }
    it->Release();
  }

  // Values arrive already JSON-encoded, strings included, so they interpolate
  // directly. This returns "" for anything the clip does not carry, and every
  // use below is guarded, so a sparse clip simply reports fewer fields.
  const auto field = [&meta](const char* key) -> std::string {
    const auto i = meta.find(key);
    return i == meta.end() ? std::string() : i->second;
  };
  // Same, but unwraps a JSON string so it can be composed into another value.
  const auto plain = [&field](const char* key) -> std::string {
    std::string v = field(key);
    if (v.size() >= 2 && v.front() == '"' && v.back() == '"') return v.substr(1, v.size() - 2);
    return v;
  };

  const std::string compressionRatio = plain("braw_compression_ratio");

  // "Gen 5" etc. The clip stores it as a bare integer under viewing_bmdgen.
  std::string colorScience;
  if (!field("viewing_bmdgen").empty())
    colorScience = "\"Gen " + plain("viewing_bmdgen") + "\"";

  const std::string rational = rationalForRate(frameRate);

  std::ostringstream o;
  o << "{";
  o << "\"width\":" << width;
  o << ",\"height\":" << height;
  o << ",\"frameRate\":" << frameRate;
  o << ",\"frameRateRational\":\"" << rational << "\"";
  o << ",\"frameCount\":" << frameCount;
  o << ",\"pixelFormat\":\"" << pf.ffmpegName << "\"";
  o << ",\"hasAudio\":" << (hasAudio ? "true" : "false");
  if (hasAudio) {
    o << ",\"audioChannels\":" << channels;
    o << ",\"audioSampleRate\":" << sampleRate;
    o << ",\"audioBitDepth\":" << bitDepth;
    o << ",\"audioSampleCount\":" << sampleCount;
  }
  // "Blackmagic RAW 3:1" reads better in the UI than the bare format name.
  o << ",\"codecFriendly\":\"Blackmagic RAW"
    << (compressionRatio.empty() ? "" : " " + compressionRatio) << "\"";
  if (!compressionRatio.empty()) o << ",\"compressionRatio\":\"" << jsonEscape(compressionRatio) << "\"";
  if (!cameraType.empty())       o << ",\"cameraType\":\"" << jsonEscape(cameraType) << "\"";
  if (!timecode.empty())         o << ",\"timecode\":\"" << jsonEscape(timecode) << "\"";
  if (!colorScience.empty())     o << ",\"colorScience\":" << colorScience;

  // Production metadata a QC operator looks for. reelName lines up with the
  // field inspector.js already reports for every other format.
  for (const auto& [jsonKey, metaKey] : {
         std::pair<const char*, const char*>{ "reelName",        "reel_name" },
         { "clipNumber",      "clip_number" },
         { "scene",           "scene" },
         { "take",            "take" },
         { "goodTake",        "good_take" },
         { "lensType",        "lens_type" },
         { "cameraNumber",    "camera_number" },
         { "dateRecorded",    "date_recorded" },
         { "firmwareVersion", "firmware_version" },
         { "viewingGamma",    "viewing_gamma" },
         { "viewingGamut",    "viewing_gamut" },
       }) {
    const std::string value = field(metaKey);
    if (!value.empty()) o << ",\"" << jsonKey << "\":" << value;
  }
  o << "}";

  const std::string json = o.str();
  std::fwrite(json.data(), 1, json.size(), stdout);
  std::fflush(stdout);
  return 0;
}

// ---------------------------------------------------------------------------
// --dump-metadata (diagnostic; not part of the player's contract)
// ---------------------------------------------------------------------------

int runDumpMetadata(const std::string& path) {
  Clip c;
  if (!c.open(path)) return 1;

  IBlackmagicRawMetadataIterator* it = nullptr;
  if (c.clip->GetMetadataIterator(&it) != S_OK || !it) {
    std::fprintf(stderr, "braw-decode: clip carries no metadata\n");
    return 1;
  }
  for (;;) {
    CFStringRef key = nullptr;
    if (it->GetKey(&key) != S_OK || !key) break;
    Variant v;
    VariantInit(&v);
    const std::string value = (it->GetData(&v) == S_OK) ? variantToJson(v) : std::string();
    std::printf("%-34s vt=%u  %s\n", cfToStd(key).c_str(), v.vt,
                value.empty() ? "(unrepresentable)" : value.c_str());
    VariantClear(&v);
    if (it->Next() != S_OK) break;
  }
  it->Release();
  return 0;
}

// ---------------------------------------------------------------------------
// --audio-out
// ---------------------------------------------------------------------------

void writeLE(std::FILE* f, uint32_t value, int bytes) {
  for (int i = 0; i < bytes; ++i) std::fputc((value >> (8 * i)) & 0xFF, f);
}

/** Write the clip's PCM to a RIFF/WAVE file. */
bool extractAudio(IBlackmagicRawClip* clip, const std::string& outPath) {
  IBlackmagicRawClipAudio* audio = nullptr;
  if (clip->QueryInterface(IID_IBlackmagicRawClipAudio, reinterpret_cast<void**>(&audio)) != S_OK || !audio)
    return false;   // no audio is not an error

  uint32_t channels = 0, sampleRate = 0, bitDepth = 0;
  uint64_t sampleCount = 0;
  audio->GetAudioChannelCount(&channels);
  audio->GetAudioSampleRate(&sampleRate);
  audio->GetAudioBitDepth(&bitDepth);
  audio->GetAudioSampleCount(&sampleCount);

  if (!channels || !sampleRate || !bitDepth || !sampleCount) {
    audio->Release();
    return false;
  }

  std::FILE* f = std::fopen(outPath.c_str(), "wb");
  if (!f) {
    std::fprintf(stderr, "braw-decode: cannot write audio to '%s'\n", outPath.c_str());
    audio->Release();
    return false;
  }

  const uint32_t bytesPerFrame = channels * (bitDepth / 8);
  const uint32_t dataBytes = static_cast<uint32_t>(sampleCount * bytesPerFrame);

  std::fwrite("RIFF", 1, 4, f);
  writeLE(f, 36 + dataBytes, 4);
  std::fwrite("WAVEfmt ", 1, 8, f);
  writeLE(f, 16, 4);                              // fmt chunk size
  writeLE(f, 1, 2);                               // PCM
  writeLE(f, channels, 2);
  writeLE(f, sampleRate, 4);
  writeLE(f, sampleRate * bytesPerFrame, 4);      // byte rate
  writeLE(f, bytesPerFrame, 2);                   // block align
  writeLE(f, bitDepth, 2);
  std::fwrite("data", 1, 4, f);
  writeLE(f, dataBytes, 4);

  // A fixed window, so a long clip does not allocate its whole audio track.
  constexpr uint32_t kSamplesPerRead = 4096;
  std::vector<uint8_t> buffer(kSamplesPerRead * bytesPerFrame);
  uint64_t written = 0;
  bool ok = true;

  while (written < sampleCount) {
    uint32_t samplesRead = 0, bytesRead = 0;
    if (audio->GetAudioSamples(static_cast<int64_t>(written), buffer.data(),
                               static_cast<uint32_t>(buffer.size()),
                               kSamplesPerRead, &samplesRead, &bytesRead) != S_OK
        || samplesRead == 0) {
      ok = false;
      break;
    }
    std::fwrite(buffer.data(), 1, bytesRead, f);
    written += samplesRead;
  }

  std::fclose(f);
  audio->Release();

  if (!ok)
    std::fprintf(stderr, "braw-decode: audio extraction stopped after %llu of %llu samples\n",
                 static_cast<unsigned long long>(written),
                 static_cast<unsigned long long>(sampleCount));
  return ok;
}

// ---------------------------------------------------------------------------
// --frames
// ---------------------------------------------------------------------------

int runFrames(const std::string& path, uint64_t startFrame,
              const std::string& audioOut, const PixelFormat& pf) {
  Clip c;
  if (!c.open(path)) return 1;

  uint32_t width = 0, height = 0;
  uint64_t frameCount = 0;
  c.clip->GetWidth(&width);
  c.clip->GetHeight(&height);
  c.clip->GetFrameCount(&frameCount);

  if (startFrame >= frameCount) {
    std::fprintf(stderr, "braw-decode: --start-frame %llu is past the last frame (%llu)\n",
                 static_cast<unsigned long long>(startFrame),
                 static_cast<unsigned long long>(frameCount));
    return 1;
  }

  // Audio first, and fully: the player adds it to ffmpeg as a second input, so
  // a half-written file would be worse than none.
  if (!audioOut.empty()) extractAudio(c.clip, audioOut);

  const size_t expectedBytes = static_cast<size_t>(width) * height * pf.bytesPerPixel;

  FrameWriter writer(startFrame, frameCount - 1, expectedBytes);
  std::atomic<int> jobsInFlight{0};
  DecodeCallback callback(&writer, pf.sdkFormat, &jobsInFlight);

  if (c.codec->SetCallback(&callback) != S_OK) {
    std::fprintf(stderr, "braw-decode: could not install the decode callback\n");
    return 1;
  }

  std::fprintf(stderr, "braw-decode: %ux%u, %llu frames, from frame %llu, %s\n",
               width, height, static_cast<unsigned long long>(frameCount),
               static_cast<unsigned long long>(startFrame), pf.ffmpegName);

  // Submitter. Separate from the writer so a blocked pipe never stops the
  // decoder being fed, and bounded so RAM use stays flat.
  std::atomic<bool> submitFailed{false};
  std::thread submitter([&] {
    for (uint64_t index = startFrame; index < frameCount; ++index) {
      for (;;) {
        if (writer.failed()) return;
        const bool tooManyJobs = jobsInFlight.load() >= kMaxJobsInFlight;
        const bool tooFarAhead = index >= writer.writePosition() + kMaxFramesAhead;
        if (!tooManyJobs && !tooFarAhead) break;
        std::this_thread::sleep_for(std::chrono::microseconds(200));
      }

      IBlackmagicRawJob* readJob = nullptr;
      if (c.clip->CreateJobReadFrame(index, &readJob) != S_OK) {
        writer.fail("could not create a read job for frame " + std::to_string(index));
        submitFailed = true;
        return;
      }
      auto* ctx = new JobContext{ index };
      readJob->SetUserData(ctx);
      ++jobsInFlight;
      if (readJob->Submit() != S_OK) {
        --jobsInFlight;
        delete ctx;
        readJob->Release();
        writer.fail("could not submit frame " + std::to_string(index));
        submitFailed = true;
        return;
      }
    }
  });

  const bool ok = writer.drain();

  // Tear down in this order: stop feeding, let the SDK finish what it has, then
  // release. Releasing the codec with jobs outstanding crashes inside the SDK.
  if (submitter.joinable()) submitter.join();
  c.codec->FlushJobs();

  return (ok && !submitFailed) ? 0 : 1;
}

// ---------------------------------------------------------------------------

void usage(const char* argv0) {
  std::fprintf(stderr,
    "braw-decode — decode Blackmagic RAW for MaidenPlayer\n"
    "\n"
    "  %s --info <file.braw>\n"
    "      Print one JSON object describing the clip.\n"
    "\n"
    "  %s --frames <file.braw> [--start-frame N] [--audio-out out.wav]\n"
    "                          [--pixel-format rgb48le|rgba64le]\n"
    "      Write raw frames to stdout.\n"
    "\n"
    "  %s --dump-metadata <file.braw>\n"
    "      List every metadata key in the clip (diagnostic).\n",
    argv0, argv0, argv0);
}

}  // namespace

int main(int argc, const char* argv[]) {
  if (argc < 3) { usage(argv[0]); return 2; }

  const std::string mode = argv[1];
  const std::string file = argv[2];
  uint64_t startFrame = 0;
  std::string audioOut;
  std::string pixelFormatName = kDefaultPixelFormat->ffmpegName;

  for (int i = 3; i < argc; ++i) {
    const std::string flag = argv[i];
    const bool hasValue = (i + 1 < argc);
    if (flag == "--start-frame" && hasValue) {
      startFrame = std::strtoull(argv[++i], nullptr, 10);
    } else if (flag == "--audio-out" && hasValue) {
      audioOut = argv[++i];
    } else if (flag == "--pixel-format" && hasValue) {
      pixelFormatName = argv[++i];
    } else {
      std::fprintf(stderr, "braw-decode: unrecognised argument '%s'\n", flag.c_str());
      return 2;
    }
  }

  const PixelFormat* pf = findPixelFormat(pixelFormatName);
  if (!pf) {
    std::fprintf(stderr, "braw-decode: unsupported --pixel-format '%s'\n", pixelFormatName.c_str());
    return 2;
  }

  if (mode == "--info")          return runInfo(file, *pf);
  if (mode == "--frames")        return runFrames(file, startFrame, audioOut, *pf);
  if (mode == "--dump-metadata") return runDumpMetadata(file);

  usage(argv[0]);
  return 2;
}
