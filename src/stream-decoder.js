/**
 * MaidenPlayer — Stream Decoder v1.1.0
 *
 * Decodes ProRes/DNxHD/DNxHR (and other non-native codecs) in real-time
 * by spawning ffmpeg to transcode to fragmented MP4 (fMP4) and streaming
 * the output chunks to the renderer process via IPC.
 *
 * The renderer uses MediaSource Extensions (MSE) to feed the fMP4 chunks
 * into a <video> element, achieving near-instant playback (<1 second to
 * first frame) without waiting for a full transcode.
 *
 * Architecture:
 *   ProRes/DNx input → ffmpeg (H.264 ultrafast → fMP4) → pipe:1 (stdout)
 *   Main process reads stdout chunks → IPC → renderer SourceBuffer
 *
 * Seeking: stop current ffmpeg, restart with -ss at new position.
 */

const { spawn } = require('child_process');
const { FFMPEG } = require('./transcoder');
const braw = require('./braw');
const dcp = require('./dcp');

class StreamDecoder {
  constructor() {
    this.process = null;
    // Upstream frame source for formats FFmpeg cannot open at all. Only .braw
    // uses it today: braw-decode writes raw frames into ffmpeg's stdin.
    this.preProcess = null;
    this.active = false;
    this.filePath = null;
    this.probeInfo = null;

    this.flowPaused = false;

    // Callbacks (set by caller)
    this.onData = null;    // (Buffer) => void
    this.onEnd = null;     // () => void
    this.onError = null;   // (string) => void
    this.onProgress = null; // (number) => void  — current time in seconds

    // DCP only. JPEG 2000 resolution levels to skip (0 full, 1 half, …), set
    // by the caller before start(); null leaves it to dcp.defaultLowres().
    this.dcpLowres = null;
    // ({ rate, fps, lowres }) => void — the decode is running slower than the
    // picture plays, measured over its first seconds. The caller decides
    // whether to restart at a lower resolution.
    this.onTooSlow = null;
    this.speedWatch = null;
    // Stops the feed of decrypted sound for an encrypted DCP, while one runs.
    this.dcpSoundStop = null;
    // The running stream's input scripts, while they still hold content keys.
    this.dcpSecrets = null;
  }

  /**
   * Backpressure control.
   *
   * ffmpeg decodes far faster than realtime — a 60s ProRes clip finishes in
   * about 7s — and every chunk it emits crosses IPC and is appended on the
   * renderer's main thread. Left unthrottled that saturates the UI thread for
   * as long as the decode runs, so the transport controls stop responding
   * until the whole file has streamed.
   *
   * Pausing stdout stops the 'data' events AND lets the OS pipe fill, which
   * blocks ffmpeg's own writes — so the decoder ends up running at roughly the
   * rate the player consumes, instead of flat out.
   */
  pauseFlow() {
    if (!this.process || !this.process.stdout || this.flowPaused) return;
    this.process.stdout.pause();
    this.flowPaused = true;
  }

  resumeFlow() {
    if (!this.process || !this.process.stdout || !this.flowPaused) return;
    this.process.stdout.resume();
    this.flowPaused = false;
  }

  /**
   * Start streaming decode of a file.
   * @param {string} filePath - Path to the source video file
   * @param {object} probeInfo - Probe result from transcoder.probeFile()
   * @param {number} seekTime - Start position in seconds (0 for beginning)
   */
  start(filePath, probeInfo, seekTime = 0) {
    // Stop any existing process
    this.stop();

    this.filePath = filePath;
    this.probeInfo = probeInfo;
    this.active = true;

    const isBraw = !!probeInfo.isBraw;
    const fps = probeInfo.fps || 0;

    // A DCP is a composition, not a file: its reels come in as two concat
    // inputs, picture then sound, already cut to the seek position.
    let dcpPlan = null;
    let dcpLowres = 0;
    if (!isBraw && dcp.isDcpProbe(probeInfo)) {
      dcpLowres = this.dcpLowres === null ? dcp.defaultLowres(probeInfo) : this.dcpLowres;
      try {
        dcpPlan = dcp.inputArgs(probeInfo.dcp, seekTime, dcpLowres);
      } catch (err) {
        console.error('[StreamDecoder] DCP input error:', err.message);
        this.active = false;
        if (this.onError) this.onError('Could not prepare the DCP: ' + err.message);
        return;
      }
    }
    this.speedWatch = dcpPlan ? { fps, lowres: dcpLowres, t0: 0, f0: 0, done: false } : null;

    // BRAW audio is not wired up yet. The helper has to finish writing the
    // clip's PCM to a file before FFmpeg can take it as a second input, and
    // that pre-pass has to complete before frame decoding starts — which
    // start() being synchronous does not allow. Video first; audio needs a
    // wider change than this path.
    const hasAudio = isBraw ? false : dcpPlan ? dcpPlan.hasSound : !!(probeInfo.audioCodec);
    // Which ffmpeg input carries the audio: the file itself, or the DCP's
    // sound reels.
    const audioInput = dcpPlan ? 1 : 0;
    const duration = probeInfo.duration || 0;

    // Build ffmpeg arguments
    const args = [];

    if (isBraw) {
      // FFmpeg never opens the .braw here — it reads headerless frames from
      // the helper on stdin. Nothing about them can be inferred, so geometry,
      // pixel format and rate all have to be declared up front.
      args.push(
        '-f', 'rawvideo',
        '-pixel_format', probeInfo.brawPixelFormat || braw.DEFAULT_PIXEL_FORMAT,
        '-video_size', (probeInfo.width || 0) + 'x' + (probeInfo.height || 0),
        // Exact rational rate, so 23.976 does not drift the way 23.98 would.
        '-framerate', probeInfo.brawFrameRateRational || String(probeInfo.fps || 24),
        '-i', 'pipe:0'
      );
    } else if (dcpPlan) {
      args.push(...dcpPlan.args);
    } else {
      // Seek position (before input for fast seek)
      if (seekTime > 0) {
        args.push('-ss', String(seekTime));
      }

      // Input
      args.push('-i', filePath);
    }

    // Video encoding: H.264 ultrafast for speed, High profile for MSE compat
    args.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      // Ensure even dimensions. A DCP is X'Y'Z'; the scaler takes it to RGB
      // and on to YUV, and saying which YUV (and tagging the stream to match)
      // keeps Chromium from guessing a different matrix on the way back.
      //
      // For a DCP that conversion is the slowest stage of the whole pipeline,
      // slower than the JPEG 2000 decode: on one thread it held a 2K picture
      // to 16 fps where the decoder alone managed 27. Giving the scaler a few
      // threads (more starves the decoder) measured 23 fps at full size and
      // 61 instead of 44 at half, with byte-identical output.
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2' +
        (dcpPlan ? ':out_color_matrix=bt709:threads=' + (dcpLowres > 0 ? 2 : 4) : '')
    );
    if (dcpPlan) args.push('-colorspace', 'bt709');

    // Audio encoding (if present)
    if (hasAudio) {
      const audioStreams = probeInfo.audioStreamCount || 1;
      // AAC tops out at 8 channels, and Chromium will not decode more than
      // that in MP4 either.
      const totalChannels = Math.min(probeInfo.audioChannelsTotal || 2, 8);

      if (audioStreams > 1) {
        // Discrete tracks (a stereo pair carried as two monos, 5.1 as six
        // monos). Without an explicit map ffmpeg keeps only ONE of them, so
        // every other track would be inaudible and unmeterable. amerge
        // interleaves them into a single stream that preserves each track as
        // its own channel.
        const inputs = Array.from({ length: audioStreams }, (_, i) => '[' + audioInput + ':a:' + i + ']').join('');
        args.push(
          '-filter_complex', inputs + 'amerge=inputs=' + audioStreams + '[aout]',
          '-map', '0:v:0',
          '-map', '[aout]'
        );
      } else {
        args.push('-map', '0:v:0', '-map', audioInput + ':a:0');
      }
      // DCP: keep the 5.1 bed and leave HI/VI-N and the sync tracks behind.
      if (dcpPlan && dcpPlan.soundFilter) args.push('-af', dcpPlan.soundFilter);

      args.push(
        '-c:a', 'aac',
        '-b:a', totalChannels > 2 ? '384k' : '192k',
        // Preserve the source channel count. Forcing stereo here used to
        // collapse 5.1 masters down to two channels, making it impossible to
        // meter or hear the surrounds.
        '-ac', String(Math.max(1, totalChannels)),
        '-ar', '48000'
      );
    } else {
      args.push('-map', '0:v:0', '-an');
    }

    // Output: fragmented MP4 to stdout
    args.push(
      '-f', 'mp4',
      '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration', '500000',  // 0.5 second fragments
      '-y',
      'pipe:1'
    );

    console.log('[StreamDecoder] Starting:', FFMPEG, args.join(' '));

    try {
      this.process = spawn(FFMPEG, args, {
        windowsHide: true,
        // A fourth pipe carries an encrypted DCP's sound, decrypted here.
        stdio: [isBraw ? 'pipe' : 'ignore', 'pipe', 'pipe'].concat(dcpPlan && dcpPlan.soundPump ? ['pipe'] : []),
      });
      this.flowPaused = false;   // fresh process starts flowing
      if (dcpPlan && dcpPlan.soundPump) this.dcpSoundStop = dcpPlan.soundPump(this.process.stdio[3]);
    } catch (err) {
      console.error('[StreamDecoder] Spawn error:', err.message);
      this.active = false;
      if (this.onError) this.onError('Failed to start ffmpeg: ' + err.message);
      return;
    }

    if (isBraw && !this.startBrawSource(filePath, probeInfo, seekTime)) {
      return;   // startBrawSource has already reported and torn down
    }

    // Read fMP4 data from stdout
    this.dcpSecrets = dcpPlan && dcpPlan.secretFiles.length ? dcpPlan : null;
    this.process.stdout.on('data', (chunk) => {
      // Output means ffmpeg has read its inputs' scripts; an encrypted DCP's
      // carry content keys, so they come off the disk now.
      if (this.dcpSecrets) { dcp.forgetSecrets(this.dcpSecrets); this.dcpSecrets = null; }
      if (!this.active) return;
      if (this.onData) this.onData(chunk);
    });

    // Parse progress from stderr
    this.process.stderr.on('data', (d) => {
      if (!this.active) return;
      const text = d.toString();
      this.watchSpeed(text);
      // Parse time= for progress
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (timeMatch && this.onProgress) {
        const currentTime = parseInt(timeMatch[1]) * 3600 +
                           parseInt(timeMatch[2]) * 60 +
                           parseInt(timeMatch[3]) +
                           parseInt(timeMatch[4]) / 100;
        this.onProgress(seekTime + currentTime);
      }
    });

    this.process.on('close', (code) => {
      console.log('[StreamDecoder] Process exited with code:', code);
      if (!this.active) return; // Was stopped intentionally
      this.active = false;
      this.process = null;

      if (code === 0) {
        if (this.onEnd) this.onEnd();
      } else {
        // code !== 0 and we didn't stop it — could be an error
        // But ffmpeg often exits with 1 when killed, so only report if truly active
        if (this.onError) this.onError('ffmpeg exited with code ' + code);
      }
    });

    this.process.on('error', (err) => {
      console.error('[StreamDecoder] Process error:', err.message);
      this.active = false;
      this.process = null;
      if (this.onError) this.onError('ffmpeg error: ' + err.message);
    });
  }

  /**
   * DCP only: is the decode keeping up with the picture?
   *
   * JPEG 2000 in software is the one format here that can be slower than
   * realtime — measured on a 16-thread desktop, a 2K DCP decodes at about 16
   * fps at full size and 46 at half. So the frame counter in ffmpeg's own
   * progress line is timed over the first three seconds of steady output and,
   * if the rate is under the picture's, onTooSlow fires — once per start.
   *
   * Backpressure makes the counter meaningless (a paused pipe is not a slow
   * decoder), so the measurement is abandoned if it engages first. It cannot
   * engage early in practice: it needs 30 s buffered ahead.
   */
  watchSpeed(text) {
    const w = this.speedWatch;
    if (!w || w.done) return;
    if (this.flowPaused) { w.done = true; return; }
    const all = text.match(/frame=\s*(\d+)/g);
    if (!all) return;
    const frames = parseInt(all[all.length - 1].replace(/\D+/g, ''), 10);
    if (!(frames > 0)) return;
    const now = Date.now();
    if (!w.t0) { w.t0 = now; w.f0 = frames; return; }
    const elapsed = (now - w.t0) / 1000;
    if (elapsed < 3) return;
    w.done = true;
    const rate = (frames - w.f0) / elapsed;
    console.log('[StreamDecoder] DCP decode rate: ' + rate.toFixed(1) + ' fps for a ' + w.fps + ' fps picture (lowres ' + w.lowres + ')');
    if (w.fps > 0 && rate < w.fps * 1.05 && this.onTooSlow) {
      this.onTooSlow({ rate, fps: w.fps, lowres: w.lowres });
    }
  }

  /**
   * Start braw-decode and pipe its frames into the ffmpeg we just spawned.
   *
   * Seeking is by FRAME here, not by time: rawvideo carries no timestamps for
   * `-ss` to act on, so the helper is told where to begin instead.
   *
   * @returns {boolean} false if it could not start (already reported).
   */
  startBrawSource(filePath, probeInfo, seekTime) {
    const fps = probeInfo.fps || 0;
    const startFrame = seekTime > 0 && fps > 0 ? Math.round(seekTime * fps) : 0;

    try {
      this.preProcess = braw.spawnFrames(filePath, { startFrame });
    } catch (err) {
      console.error('[StreamDecoder] braw-decode spawn error:', err.message);
      this.stop();
      if (this.onError) this.onError(err.message);
      return false;
    }

    this.preProcess.stdout.pipe(this.process.stdin);

    // EPIPE is expected every time we stop or seek: ffmpeg dies first and the
    // helper is still mid-write. Swallow it, or it surfaces as a crash.
    this.process.stdin.on('error', (err) => {
      if (err && err.code !== 'EPIPE') {
        console.error('[StreamDecoder] ffmpeg stdin error:', err.message);
      }
    });

    this.preProcess.stderr.on('data', (d) => {
      console.log('[Braw] ' + d.toString().trimEnd());
    });

    this.preProcess.on('error', (err) => {
      if (!this.active) return;
      console.error('[StreamDecoder] braw-decode error:', err.message);
      this.stop();
      if (this.onError) this.onError('Blackmagic RAW decoder failed: ' + err.message);
    });

    this.preProcess.on('close', (code) => {
      // A non-zero exit only matters while we still expect frames — killing
      // the helper on stop() or seek() is the normal case.
      if (this.active && code !== 0 && code !== null) {
        console.error('[StreamDecoder] braw-decode exited with code:', code);
      }
    });

    return true;
  }

  /**
   * Stop the current decode process.
   */
  stop() {
    this.active = false;
    if (this.preProcess) {
      console.log('[StreamDecoder] Stopping braw-decode');
      try {
        this.preProcess.stdout.unpipe();
        this.preProcess.stdout.removeAllListeners();
        this.preProcess.stderr.removeAllListeners();
        this.preProcess.removeAllListeners();
        this.preProcess.kill('SIGKILL');
      } catch (_) { /* ignore */ }
      this.preProcess = null;
    }
    // Stopped before any output: the scripts with content keys are still there.
    if (this.dcpSecrets) { dcp.forgetSecrets(this.dcpSecrets); this.dcpSecrets = null; }
    if (this.dcpSoundStop) {
      try { this.dcpSoundStop(); } catch (_) { /* ignore */ }
      this.dcpSoundStop = null;
    }
    if (this.process) {
      console.log('[StreamDecoder] Stopping process');
      try {
        this.process.stdout.removeAllListeners();
        this.process.stderr.removeAllListeners();
        this.process.removeAllListeners();
        this.process.kill('SIGKILL');
      } catch (_) { /* ignore */ }
      this.process = null;
    }
  }

  /**
   * Seek to a new position by restarting ffmpeg.
   * @param {number} time - Position in seconds
   */
  seek(time) {
    if (!this.filePath || !this.probeInfo) {
      console.warn('[StreamDecoder] Cannot seek — no file loaded');
      return;
    }
    console.log('[StreamDecoder] Seeking to:', time);
    this.start(this.filePath, this.probeInfo, time);
  }

  /**
   * Check if a decode is currently active.
   */
  isActive() {
    return this.active;
  }
}

module.exports = { StreamDecoder };
