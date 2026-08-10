/**
 * PokitPlayer — Stream Decoder v1.1.0
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

class StreamDecoder {
  constructor() {
    this.process = null;
    this.active = false;
    this.filePath = null;
    this.probeInfo = null;

    // Callbacks (set by caller)
    this.onData = null;    // (Buffer) => void
    this.onEnd = null;     // () => void
    this.onError = null;   // (string) => void
    this.onProgress = null; // (number) => void  — current time in seconds
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

    const hasAudio = !!(probeInfo.audioCodec);
    const duration = probeInfo.duration || 0;

    // Build ffmpeg arguments
    const args = [];

    // Seek position (before input for fast seek)
    if (seekTime > 0) {
      args.push('-ss', String(seekTime));
    }

    // Input
    args.push('-i', filePath);

    // Video encoding: H.264 ultrafast for speed, High profile for MSE compat
    args.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      // Ensure even dimensions
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2'
    );

    // Audio encoding (if present)
    if (hasAudio) {
      args.push(
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',
        '-ar', '48000'
      );
    } else {
      args.push('-an');
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
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      console.error('[StreamDecoder] Spawn error:', err.message);
      this.active = false;
      if (this.onError) this.onError('Failed to start ffmpeg: ' + err.message);
      return;
    }

    // Read fMP4 data from stdout
    this.process.stdout.on('data', (chunk) => {
      if (!this.active) return;
      if (this.onData) this.onData(chunk);
    });

    // Parse progress from stderr
    this.process.stderr.on('data', (d) => {
      if (!this.active) return;
      const text = d.toString();
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
   * Stop the current decode process.
   */
  stop() {
    this.active = false;
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
