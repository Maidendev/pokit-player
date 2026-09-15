/**
 * MaidenPlayer — Renderer Process v1.1.3
 * Handles video playback, UI, keyboard shortcuts, timecode,
 * ProRes/DNX streaming decode via MSE, and image sequence support.
 *
 * v1.1.3: Video centering fix — the title bar is now an overlay so the video
 * is centered both horizontally and vertically in the full viewport, with
 * symmetric letterboxing regardless of window size or video aspect ratio.
 *
 * v1.1.1: Source timecode support — reads embedded timecode from professional
 * video files and displays it as the running timecode offset.
 *
 * v1.1.0: Added MediaSource Extensions (MSE) streaming playback.
 * Non-native codecs (ProRes, DNxHD/HR, etc.) are now decoded in real-time
 * via ffmpeg → fragmented MP4 → MSE SourceBuffer, giving near-instant
 * playback without waiting for a full transcode.
 */

(function () {
  'use strict';

  // ─── DOM Elements ─────────────────────────────────────
  const video = document.getElementById('video-player');
  const dropZone = document.getElementById('drop-zone');
  const dragOverlay = document.getElementById('drag-overlay');
  const bigPlayBtn = document.getElementById('big-play-btn');
  const controlsBar = document.getElementById('controls-bar');
  const titleText = document.getElementById('title-text');

  // Controls
  const btnPlay = document.getElementById('btn-play');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const btnSkipBack = document.getElementById('btn-skip-back');
  const btnSkipFwd = document.getElementById('btn-skip-fwd');
  const btnPrevFrame = document.getElementById('btn-prev-frame');
  const btnNextFrame = document.getElementById('btn-next-frame');
  const btnLoop = document.getElementById('btn-loop');
  const sdiBadge = document.getElementById('sdi-badge');
  const btnMute = document.getElementById('btn-mute');
  const volumeSlider = document.getElementById('volume-slider');
  const btnInfo = document.getElementById('btn-info');
  const btnFullscreen = document.getElementById('btn-fullscreen');

  // Volume icons
  const iconVolHigh = document.getElementById('icon-vol-high');
  const iconVolLow = document.getElementById('icon-vol-low');
  const iconVolMute = document.getElementById('icon-vol-mute');

  // Fullscreen icons
  const iconFsEnter = document.getElementById('icon-fs-enter');
  const iconFsExit = document.getElementById('icon-fs-exit');

  // Timeline
  const timelineContainer = document.getElementById('timeline-container');
  const timelineTrack = document.getElementById('timeline-track');
  const timelineBuffered = document.getElementById('timeline-buffered');
  const timelineProgress = document.getElementById('timeline-progress');
  const timelineThumb = document.getElementById('timeline-thumb');
  const timelineTooltip = document.getElementById('timeline-tooltip');

  // Timecode
  const timecodeCurrent = document.getElementById('timecode-current');
  const timecodeTotal = document.getElementById('timecode-total');

  // Info & Shortcuts panels
  const fileInfoPanel = document.getElementById('file-info-panel');
  const shortcutsPanel = document.getElementById('shortcuts-panel');
  const btnCloseInfo = document.getElementById('btn-close-info');
  const btnCloseShortcuts = document.getElementById('btn-close-shortcuts');

  // Transcode overlay
  const transcodeOverlay = document.getElementById('transcode-overlay');
  const transcodeMessage = document.getElementById('transcode-message');
  const transcodeProgressBar = document.getElementById('transcode-progress-bar');
  const transcodePercent = document.getElementById('transcode-percent');
  const transcodeCodecInfo = document.getElementById('transcode-codec-info');

  // Image Sequence dialog
  const seqDialog = document.getElementById('seq-fps-dialog');
  const seqFpsSelect = document.getElementById('seq-fps-select');
  const seqInfoText = document.getElementById('seq-info-text');
  const seqBtnRender = document.getElementById('seq-btn-render');
  const seqBtnCancel = document.getElementById('seq-btn-cancel');

  // ─── State ────────────────────────────────────────────
  let currentFilePath = null;
  let originalFilePath = null; // The original file (before transcode)
  let frameRate = 24;
  let frameDuration = 1 / frameRate;
  let controlsTimeout = null;
  let isTimelineDragging = false;
  let hasVideoLoaded = false;
  let lastVolume = 1;
  let currentProbeInfo = null;
  let pendingSequenceInfo = null;
  let wasTranscoded = false;

  // ─── JKL Shuttle State ──────────────────────────────────
  const SHUTTLE_MAX_SPEED = 8;
  let shuttleDirection = 0;   // -1 reverse, 0 stopped, 1 forward
  let shuttleSpeed = 1;       // speed multiplier, doubles with repeated J/L presses
  let shuttleRAF = null;      // requestAnimationFrame handle driving reverse playback
  let shuttleLastTs = null;

  // ─── Source Timecode Offset (v1.1.1) ───────────────────
  let sourceTimecodeOffset = 0;   // Offset in seconds from embedded timecode
  let sourceTimecodeStr = null;   // Original timecode string e.g. "01:00:00:00"

  // ─── MSE Streaming State (v1.1.0) ─────────────────────
  let streamMode = false;           // true when using MSE streaming playback
  let loopEnabled = false;          // Loop Playback — see toggleLoop()
  const JUMP_SECONDS = 1;           // Cmd/Ctrl-arrow and the skip buttons
  // External video output (Blackmagic SDI). The selected device comes from
  // the Playback menu via main; this side drives it from the transport.
  let sdiDevice = null;             // selected device, or null for built-in
  let sdiActive = false;            // an output session is running
  let currentSeqInfo = null;        // image-sequence details, so SDI decodes the ORIGINALS
  let sdiRestartTimer = null;
  let mediaSource = null;           // MediaSource instance
  let sourceBuffer = null;          // SourceBuffer for fMP4 data
  let pendingBuffers = [];          // Queue of ArrayBuffers waiting to be appended
  let isAppending = false;          // SourceBuffer update in progress
  let streamSeekTime = 0;           // The -ss time passed to ffmpeg
  let streamEnded = false;          // ffmpeg finished sending data
  let firstDataReceived = false;    // Track when first chunk arrives
  let mseReady = false;             // MediaSource is open and SourceBuffer created
  const MSE_CODEC = 'video/mp4; codecs="avc1.640029,mp4a.40.2"'; // H.264 High 4.1 + AAC-LC
  const MSE_CODEC_VIDEO_ONLY = 'video/mp4; codecs="avc1.640029"'; // H.264 High 4.1 (no audio)
  const BUFFER_KEEP_BEHIND = 30;    // Seconds of buffer to keep behind currentTime

  // ─── Utility Functions ────────────────────────────────

  function secondsToTimecode(seconds, fps) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const roundedFps = Math.round(fps);
    // A frame boundary computed as n / fps comes back as (n - 1e-14) once
    // multiplied out again, and floor() then reports the frame BEFORE it —
    // so the same In point could read 04:04 in one place and 04:05 in
    // another. The epsilon is far below a frame and removes the ambiguity.
    const totalFrames = Math.floor(seconds * fps + 1e-6);
    const ff = totalFrames % roundedFps;
    const totalSeconds = Math.floor(seconds);
    const ss = totalSeconds % 60;
    const mm = Math.floor(totalSeconds / 60) % 60;
    const hh = Math.floor(totalSeconds / 3600);

    return (
      String(hh).padStart(2, '0') + ':' +
      String(mm).padStart(2, '0') + ':' +
      String(ss).padStart(2, '0') + ':' +
      String(Math.floor(ff)).padStart(2, '0')
    );
  }

  function formatFileSize(bytes) {
    if (!bytes) return 'Unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
      size /= 1024;
      i++;
    }
    return size.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  // ─── Frame Rate Detection ─────────────────────────────

  function detectFrameRate() {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      let lastTime = null;
      let frameTimes = [];

      const measure = (now, metadata) => {
        if (lastTime !== null) {
          const delta = metadata.mediaTime - lastTime;
          if (delta > 0) frameTimes.push(delta);
        }
        lastTime = metadata.mediaTime;

        if (frameTimes.length < 30) {
          video.requestVideoFrameCallback(measure);
        } else {
          frameTimes.sort((a, b) => a - b);
          const medianDelta = frameTimes[Math.floor(frameTimes.length / 2)];
          if (medianDelta > 0) {
            const measuredFps = 1 / medianDelta;
            const commonRates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
            frameRate = commonRates.reduce((prev, curr) =>
              Math.abs(curr - measuredFps) < Math.abs(prev - measuredFps) ? curr : prev
            );
            frameDuration = 1 / frameRate;
            console.log('[Renderer] Detected frame rate:', frameRate, 'fps (measured:', measuredFps.toFixed(3) + ')');
            updateFileInfoFromVideo();
          }
        }
      };

      const startMeasuring = () => {
        lastTime = null;
        frameTimes = [];
        video.requestVideoFrameCallback(measure);
        video.removeEventListener('play', startMeasuring);
      };

      video.addEventListener('play', startMeasuring);
    }
  }

  // ─── Transcoding UI ───────────────────────────────────

  function showTranscodeOverlay(message, codecInfo) {
    console.log('[Renderer] Showing transcode overlay:', message, codecInfo);
    transcodeMessage.textContent = message;
    transcodeCodecInfo.textContent = codecInfo || '';
    transcodeProgressBar.style.width = '0%';
    transcodePercent.textContent = '0%';
    transcodeOverlay.classList.remove('hidden');
    dropZone.classList.remove('visible');
  }

  function updateTranscodeProgress(pct) {
    transcodeProgressBar.style.width = pct + '%';
    transcodePercent.textContent = pct + '%';
  }

  function hideTranscodeOverlay() {
    console.log('[Renderer] Hiding transcode overlay');
    transcodeOverlay.classList.add('hidden');
  }

  // ─── Image Sequence Dialog ────────────────────────────

  function showSequenceDialog(seqInfo) {
    console.log('[Renderer] Showing sequence dialog:', seqInfo.count, 'frames');
    pendingSequenceInfo = seqInfo;
    seqInfoText.textContent =
      seqInfo.count + ' frames detected (' +
      seqInfo.prefix + '*' + seqInfo.suffix + ') — ' +
      'Frames ' + seqInfo.startFrame + '–' + seqInfo.endFrame;
    seqFpsSelect.value = '24';
    seqDialog.classList.remove('hidden');
  }

  function hideSequenceDialog() {
    seqDialog.classList.add('hidden');
    pendingSequenceInfo = null;
  }

  seqBtnCancel.addEventListener('click', hideSequenceDialog);
  seqBtnRender.addEventListener('click', async () => {
    if (!pendingSequenceInfo) return;
    const fps = parseFloat(seqFpsSelect.value);
    const seqInfo = pendingSequenceInfo;
    hideSequenceDialog();

    showTranscodeOverlay('Rendering image sequence…', seqInfo.count + ' frames → ' + fps + ' fps');

    try {
      const result = await window.electronAPI.renderImageSequence(seqInfo, fps);
      hideTranscodeOverlay();

      if (result && result.error) {
        console.error('[Renderer] Sequence render failed:', result.error);
        alert('Image sequence render failed:\n\n' + result.error);
        showDropZone();
        return;
      }

      frameRate = fps;
      frameDuration = 1 / frameRate;
      originalFilePath = seqInfo.sampleFile;
      currentSeqInfo = seqInfo;
      wasTranscoded = true;
      currentProbeInfo = {
        codecFriendly: 'Image Sequence (' + seqInfo.suffix.replace('.', '').toUpperCase() + ')',
        needsTranscode: true,
        fps: fps,
      };
      loadVideoFromPath(result.outputPath, seqInfo.prefix + '* sequence');
    } catch (err) {
      hideTranscodeOverlay();
      console.error('[Renderer] Sequence render exception:', err);
      alert('Image sequence render error:\n\n' + err.message);
      showDropZone();
    }
  });

  // ─── MSE Streaming Engine (v1.1.0) ─────────────────────

  /**
   * Clean up any existing MSE session.
   */
  function cleanupMSE() {
    console.log('[Renderer] Cleaning up MSE session');
    streamMode = false;
    // Back on the native path, so hand looping to the browser again.
    video.loop = loopEnabled;
    mseReady = false;
    firstDataReceived = false;
    streamEnded = false;
    pendingBuffers = [];
    isAppending = false;
    streamSeekTime = 0;

    if (sourceBuffer) {
      try {
        if (mediaSource && mediaSource.readyState === 'open') {
          sourceBuffer.abort();
        }
      } catch (_) { /* ignore */ }
      sourceBuffer = null;
    }

    if (mediaSource) {
      try {
        if (mediaSource.readyState === 'open') {
          mediaSource.endOfStream();
        }
      } catch (_) { /* ignore */ }
      mediaSource = null;
    }

    // Revoke any blob URL
    if (video.src && video.src.startsWith('blob:')) {
      URL.revokeObjectURL(video.src);
    }

    // Stop the backend stream
    window.electronAPI.stopStream().catch(() => {});
  }

  /**
   * Initialize MSE playback for a non-native codec file.
   * Creates MediaSource, adds SourceBuffer, starts the ffmpeg stream.
   * @param {string} filePath - Path to the source file
   * @param {object} probeInfo - Probe result
   * @param {number} seekTime - Start position (0 for beginning)
   */
  async function initMSEPlayback(filePath, probeInfo, seekTime = 0) {
    console.log('[Renderer] Initializing MSE playback for:', filePath, 'seek:', seekTime);

    // Clean up any previous MSE session
    cleanupMSE();

    streamMode = true;
    // MediaSource cannot loop itself; the 'ended' handler restarts the stream.
    video.loop = false;
    streamSeekTime = seekTime;
    streamEnded = false;
    firstDataReceived = false;

    // Determine codec string based on whether file has audio
    const hasAudio = !!(probeInfo.audioCodec);
    const codecStr = hasAudio ? MSE_CODEC : MSE_CODEC_VIDEO_ONLY;
    console.log('[Renderer] MSE codec:', codecStr, 'hasAudio:', hasAudio);

    // Check browser support
    if (!('MediaSource' in window)) {
      console.error('[Renderer] MediaSource not supported');
      alert('MediaSource Extensions not supported in this browser.');
      return false;
    }

    if (!MediaSource.isTypeSupported(codecStr)) {
      console.error('[Renderer] Codec not supported by MSE:', codecStr);
      // Fall back to full transcode
      return false;
    }

    // Create MediaSource
    mediaSource = new MediaSource();
    const blobUrl = URL.createObjectURL(mediaSource);
    video.src = blobUrl;

    // Wait for sourceopen
    await new Promise((resolve) => {
      mediaSource.addEventListener('sourceopen', () => {
        console.log('[Renderer] MediaSource opened');
        resolve();
      }, { once: true });
    });

    // Set duration from probe
    if (probeInfo.duration > 0) {
      try {
        mediaSource.duration = probeInfo.duration;
      } catch (e) {
        console.warn('[Renderer] Could not set MediaSource duration:', e.message);
      }
    }

    // Add SourceBuffer
    try {
      sourceBuffer = mediaSource.addSourceBuffer(codecStr);
      sourceBuffer.mode = 'segments';
      console.log('[Renderer] SourceBuffer created');
    } catch (e) {
      console.error('[Renderer] Failed to create SourceBuffer:', e.message);
      cleanupMSE();
      return false;
    }

    // Handle SourceBuffer updateend — process queue
    sourceBuffer.addEventListener('updateend', () => {
      isAppending = false;
      flushPendingBuffers();
      updateStreamBackpressure();

      // Auto-play after first successful append
      if (firstDataReceived && video.paused && video.readyState >= 2) {
        console.log('[Renderer] Auto-playing after first buffer');
        video.play().catch(() => {});
        hideTranscodeOverlay();
      }
    });

    // Handle errors on SourceBuffer
    sourceBuffer.addEventListener('error', (e) => {
      console.error('[Renderer] SourceBuffer error:', e);
    });

    // Set timestamp offset for seeks
    if (seekTime > 0) {
      try {
        sourceBuffer.timestampOffset = seekTime;
      } catch (e) {
        console.warn('[Renderer] Could not set timestampOffset:', e.message);
      }
    }

    mseReady = true;

    // Now start the backend stream
    console.log('[Renderer] Starting backend stream...');
    const result = await window.electronAPI.startStream(filePath, seekTime);
    if (result && result.error) {
      console.error('[Renderer] Stream start failed:', result.error);
      cleanupMSE();
      return false;
    }

    console.log('[Renderer] Stream started successfully');
    return true;
  }

  /**
   * Append a chunk of fMP4 data to the SourceBuffer.
   * Queues if SourceBuffer is busy.
   */
  function appendStreamData(data) {
    if (!streamMode || !sourceBuffer || !mseReady) return;

    // Convert to ArrayBuffer if needed (IPC sends Buffer/Uint8Array)
    let arrayBuffer;
    if (data instanceof ArrayBuffer) {
      arrayBuffer = data;
    } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
      arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    } else {
      // Try to work with whatever we got
      arrayBuffer = new Uint8Array(data).buffer;
    }

    if (!firstDataReceived) {
      firstDataReceived = true;
      console.log('[Renderer] First stream data received, size:', arrayBuffer.byteLength);
    }

    pendingBuffers.push(arrayBuffer);
    flushPendingBuffers();
  }

  // ── Streaming backpressure ────────────────────────────
  //
  // ffmpeg decodes much faster than realtime, so without this the decoder
  // races ahead and the constant IPC + appendBuffer work pins the main thread,
  // leaving the transport controls unresponsive until the whole file has
  // streamed. Holding roughly half a minute of media ahead of the playhead
  // keeps playback and seeking smooth while leaving the UI thread idle.
  const STREAM_BUFFER_HIGH_WATER = 30;   // seconds ahead → tell ffmpeg to wait
  const STREAM_BUFFER_LOW_WATER = 12;    // seconds ahead → let it run again
  let streamFlowPaused = false;

  /** Seconds of contiguous media buffered ahead of the playhead. */
  function bufferedAhead() {
    if (!sourceBuffer) return 0;
    let ranges;
    try {
      ranges = sourceBuffer.buffered;
    } catch (_) {
      return 0;   // throws if the SourceBuffer has been removed
    }
    const t = video.currentTime;
    for (let i = 0; i < ranges.length; i++) {
      if (t >= ranges.start(i) - 0.5 && t <= ranges.end(i)) return ranges.end(i) - t;
    }
    return 0;
  }

  function updateStreamBackpressure() {
    if (!streamMode) return;
    const ahead = bufferedAhead();

    if (!streamFlowPaused && ahead > STREAM_BUFFER_HIGH_WATER) {
      streamFlowPaused = true;
      window.electronAPI.setStreamFlow(false);
    } else if (streamFlowPaused && ahead < STREAM_BUFFER_LOW_WATER) {
      streamFlowPaused = false;
      window.electronAPI.setStreamFlow(true);
    }
  }

  /**
   * Flush queued buffers to SourceBuffer one at a time.
   */
  function flushPendingBuffers() {
    if (isAppending || pendingBuffers.length === 0) return;
    if (!sourceBuffer || !mseReady) return;

    // Check if MediaSource is still open
    if (mediaSource.readyState !== 'open') {
      console.warn('[Renderer] MediaSource not open, dropping pending buffers');
      pendingBuffers = [];
      return;
    }

    isAppending = true;
    const chunk = pendingBuffers.shift();

    try {
      sourceBuffer.appendBuffer(chunk);
    } catch (e) {
      isAppending = false;
      if (e.name === 'QuotaExceededError') {
        console.warn('[Renderer] QuotaExceededError — evicting old buffer data');
        evictOldBufferData();
        // Re-queue the chunk and retry
        pendingBuffers.unshift(chunk);
        setTimeout(() => flushPendingBuffers(), 100);
      } else {
        console.error('[Renderer] appendBuffer error:', e.name, e.message);
      }
    }
  }

  /**
   * Remove old buffered data to free up quota.
   */
  function evictOldBufferData() {
    if (!sourceBuffer || sourceBuffer.updating) return;
    try {
      const currentTime = video.currentTime;
      const removeEnd = Math.max(0, currentTime - BUFFER_KEEP_BEHIND);
      if (removeEnd > 0 && sourceBuffer.buffered.length > 0) {
        const bufStart = sourceBuffer.buffered.start(0);
        if (bufStart < removeEnd) {
          console.log('[Renderer] Evicting buffer:', bufStart, '→', removeEnd);
          sourceBuffer.remove(bufStart, removeEnd);
        }
      }
    } catch (e) {
      console.warn('[Renderer] Buffer eviction error:', e.message);
    }
  }

  /**
   * Handle stream end from ffmpeg.
   */
  function handleStreamEnd() {
    console.log('[Renderer] Stream ended — calling endOfStream');
    streamEnded = true;

    // Flush remaining buffers, then end
    const doEnd = () => {
      if (pendingBuffers.length > 0 || isAppending) {
        setTimeout(doEnd, 100);
        return;
      }
      if (mediaSource && mediaSource.readyState === 'open') {
        try {
          mediaSource.endOfStream();
        } catch (e) {
          console.warn('[Renderer] endOfStream error:', e.message);
        }
      }
      hideTranscodeOverlay();
    };
    doEnd();
  }

  /**
   * Handle stream error from ffmpeg.
   * Falls back to full transcode if streaming fails.
   */
  function handleStreamError(msg) {
    console.error('[Renderer] Stream error:', msg);

    // If we haven't received any data, fall back to full transcode
    if (!firstDataReceived) {
      console.log('[Renderer] No data received — falling back to full transcode');
      cleanupMSE();
      if (originalFilePath) {
        retryWithTranscode(originalFilePath);
      }
    }
    // If we have received data, the stream may have just ended with non-zero exit
    // (common when killed during seek). Ignore in that case.
  }

  /**
   * Seek within a streaming session.
   * If target is within buffered range, seek instantly.
   * Otherwise, restart the stream at the new position.
   */
  async function seekInStream(time) {
    if (!streamMode) return;

    // Clamp
    const duration = currentProbeInfo ? currentProbeInfo.duration : video.duration;
    time = Math.max(0, Math.min(duration || Infinity, time));

    // Check if target is within buffered range
    if (sourceBuffer && sourceBuffer.buffered.length > 0) {
      for (let i = 0; i < sourceBuffer.buffered.length; i++) {
        const start = sourceBuffer.buffered.start(i);
        const end = sourceBuffer.buffered.end(i);
        if (time >= start && time <= end) {
          console.log('[Renderer] Seeking within buffered range:', time);
          video.currentTime = time;
          return;
        }
      }
    }

    // Not in buffer — restart stream at new position
    console.log('[Renderer] Seeking outside buffer — restarting stream at:', time);
    showTranscodeOverlay('Seeking…', '');

    // Stop current stream
    await window.electronAPI.stopStream();

    // Reset MSE state for new position
    streamSeekTime = time;
    streamEnded = false;
    firstDataReceived = false;
    pendingBuffers = [];
    // The old decoder is gone; the replacement starts unthrottled, so clear
    // the flag or we would never ask the new one to resume.
    streamFlowPaused = false;

    // Wait for any pending update to finish
    if (sourceBuffer && sourceBuffer.updating) {
      await new Promise(resolve => {
        sourceBuffer.addEventListener('updateend', resolve, { once: true });
      });
    }

    // Clear existing buffer
    if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
      try {
        sourceBuffer.abort();
        if (sourceBuffer.buffered.length > 0) {
          sourceBuffer.remove(0, Infinity);
          await new Promise(resolve => {
            sourceBuffer.addEventListener('updateend', resolve, { once: true });
          });
        }
        // Update timestamp offset
        sourceBuffer.timestampOffset = time;
      } catch (e) {
        console.warn('[Renderer] Buffer clear error:', e.message);
      }
    }

    // Start new stream at seek position
    const result = await window.electronAPI.startStream(originalFilePath, time);
    if (result && result.error) {
      console.error('[Renderer] Seek stream start failed:', result.error);
      hideTranscodeOverlay();
    }
  }

  // ─── Video Loading ────────────────────────────────────

  /**
   * Main entry point for opening any file.
   * Determines if it needs transcoding or is an image sequence.
   */
  async function openFile(filePath) {
    console.log('[Renderer] Opening file:', filePath);
    const ext = ('.' + filePath.split('.').pop()).toLowerCase();
    const IMAGE_SEQ_EXTS = ['.dpx', '.exr', '.tif', '.tiff'];

    // For explicitly image-sequence extensions, always try sequence detection
    if (IMAGE_SEQ_EXTS.includes(ext)) {
      console.log('[Renderer] Detected image sequence extension:', ext);
      return await tryOpenAsSequence(filePath);
    }

    // For video files: probe and potentially transcode
    await openVideoFile(filePath);
  }

  async function tryOpenAsSequence(filePath) {
    console.log('[Renderer] Trying to open as sequence:', filePath);
    try {
      const seqInfo = await window.electronAPI.detectImageSequence(filePath);
      if (seqInfo && !seqInfo.error && seqInfo.count >= 2) {
        showSequenceDialog(seqInfo);
      } else {
        console.warn('[Renderer] Not a recognizable sequence:', seqInfo);
        alert(
          'Could not detect an image sequence from this file.\n\n' +
          'Make sure files follow a numbered pattern (e.g. frame_0001.dpx, frame_0002.dpx).'
        );
      }
    } catch (err) {
      console.error('[Renderer] Sequence detection error:', err);
      alert('Error detecting image sequence:\n\n' + err.message);
    }
  }

  async function openVideoFile(filePath) {
    originalFilePath = filePath;
    currentSeqInfo = null;
    currentProbeInfo = null;
    wasTranscoded = false;

    // Reset source timecode offset
    sourceTimecodeOffset = 0;
    sourceTimecodeStr = null;

    // Clean up any previous MSE session
    cleanupMSE();

    // Quick probe to check codec
    showTranscodeOverlay('Analyzing file…', '');
    console.log('[Renderer] Probing file...');

    let probe;
    try {
      probe = await window.electronAPI.probeFile(filePath);
    } catch (err) {
      console.error('[Renderer] Probe failed:', err);
      hideTranscodeOverlay();
      // Try loading directly — might work for native formats
      loadVideoFromPath(filePath);
      return;
    }

    currentProbeInfo = probe;
    console.log('[Renderer] Probe result:', JSON.stringify(probe));

    if (probe.error) {
      console.warn('[Renderer] Probe returned error:', probe.error);
      hideTranscodeOverlay();
      // Store a minimal probe info so the File Info panel can at least show the container
      currentProbeInfo = {
        codec: null,
        codecFriendly: null,
        container: filePath.split('.').pop().toLowerCase(),
        error: probe.error,
        probeFailedMessage: 'ffmpeg probe unavailable: ' + probe.error,
      };
      // Try loading directly — might work for native formats
      loadVideoFromPath(filePath);
      return;
    }

    // Use probe FPS if available
    if (probe.fps && probe.fps > 0) {
      frameRate = probe.fps;
      frameDuration = 1 / frameRate;
      console.log('[Renderer] Using probe FPS:', frameRate);
    }

    // Extract source timecode offset (v1.1.1)
    if (probe.sourceTimecode) {
      sourceTimecodeStr = probe.sourceTimecode;
      sourceTimecodeOffset = probe.sourceTimecodeSeconds || 0;
      console.log('[Renderer] Source timecode:', sourceTimecodeStr, '→ offset:', sourceTimecodeOffset, 's');
    }

    if (probe.needsTranscode) {
      // v1.1.0: Use streaming decode (MSE) instead of full transcode
      const codecLabel = probe.codecFriendly || probe.codec || 'Non-native codec';
      console.log('[Renderer] File needs decode — using streaming playback:', codecLabel);

      showTranscodeOverlay(
        'Preparing playback…',
        codecLabel + ' → Streaming'
      );

      // Try MSE streaming first
      const success = await initMSEPlayback(filePath, probe, 0);

      if (success) {
        // MSE is set up and stream is running
        // Data will arrive via IPC → appendStreamData → auto-play
        console.log('[Renderer] MSE streaming initialized — waiting for data');

        // Show controls
        const fileName = filePath.split(/[\\/]/).pop();
        titleText.textContent = fileName + ' — MaidenPlayer';
        document.title = fileName + ' — MaidenPlayer';
        dropZone.classList.remove('visible');
        controlsBar.classList.remove('hidden');
        controlsBar.classList.add('visible');
        bigPlayBtn.classList.remove('hidden');
        hasVideoLoaded = true;
        currentFilePath = filePath;

        // Detect frame rate
        detectFrameRate();

        // Load file stats
        loadFileInfo(filePath);

        // Update file info to show streaming mode
        wasTranscoded = false; // Not transcoded — streaming
        return;
      }

      // MSE streaming failed — fall back to full transcode
      console.log('[Renderer] MSE streaming failed — falling back to full transcode');
      showTranscodeOverlay(
        'Transcoding to H.264 for playback…',
        codecLabel + ' → H.264'
      );

      try {
        const result = await window.electronAPI.transcodeFile(filePath);
        hideTranscodeOverlay();

        if (result && result.error) {
          console.error('[Renderer] Transcode failed:', result.error);
          alert(
            'Transcoding failed for this file.\n\n' +
            'Codec: ' + codecLabel + '\n' +
            'Error: ' + result.error.substring(0, 300)
          );
          showDropZone();
          return;
        }

        if (result && result.alreadyNative) {
          console.log('[Renderer] File is actually native — loading directly');
          loadVideoFromPath(filePath);
          return;
        }

        console.log('[Renderer] Transcode complete:', result.outputPath);
        wasTranscoded = true;
        loadVideoFromPath(result.outputPath, filePath.split(/[\\/]/).pop());
      } catch (err) {
        hideTranscodeOverlay();
        console.error('[Renderer] Transcode exception:', err);
        alert('Transcoding error:\n\n' + err.message);
        showDropZone();
      }
    } else {
      hideTranscodeOverlay();
      console.log('[Renderer] File is native — loading directly');
      loadVideoFromPath(filePath);
    }
  }

  function showDropZone() {
    dropZone.classList.add('visible');
    controlsBar.classList.add('hidden');
    controlsBar.classList.remove('visible');
  }

  /**
   * Load a video file into the HTML5 player.
   * displayName is optional (shown in title bar if different from actual file).
   */
  function loadVideoFromPath(filePath, displayName) {
    // If we're switching from stream mode to direct file, clean up MSE
    if (streamMode) {
      cleanupMSE();
    }

    currentFilePath = filePath;
    frameDuration = 1 / frameRate;

    // Build a proper file:// URL
    // On Windows: C:\foo\bar → file:///C:/foo/bar
    // On Linux/Mac: /foo/bar → file:///foo/bar
    let fileUrl;
    if (filePath.match(/^[A-Za-z]:\\/)) {
      // Windows absolute path
      fileUrl = 'file:///' + filePath.replace(/\\/g, '/');
    } else {
      fileUrl = 'file://' + filePath;
    }

    console.log('[Renderer] Loading video URL:', fileUrl);
    video.src = fileUrl;
    video.load();

    // Update title
    const fileName = displayName || filePath.split(/[\\/]/).pop();
    titleText.textContent = fileName + ' — MaidenPlayer';
    document.title = fileName + ' — MaidenPlayer';

    // Show controls
    dropZone.classList.remove('visible');
    controlsBar.classList.remove('hidden');
    controlsBar.classList.add('visible');
    bigPlayBtn.classList.remove('hidden');
    hasVideoLoaded = true;

    // Detect frame rate (will refine the probe-based value)
    detectFrameRate();

    // Load file stats for the info panel
    loadFileInfo(originalFilePath || filePath);
  }

  // Keep backward compat name
  function loadVideo(filePath) {
    openFile(filePath);
  }

  // ─── Video Error Handling ──────────────────────────────

  video.addEventListener('error', (e) => {
    const err = video.error;
    let msg = 'Unknown playback error';
    if (err) {
      switch (err.code) {
        case MediaError.MEDIA_ERR_ABORTED: msg = 'Playback aborted'; break;
        case MediaError.MEDIA_ERR_NETWORK: msg = 'Network error while loading'; break;
        case MediaError.MEDIA_ERR_DECODE: msg = 'Decode error — codec may not be supported'; break;
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: msg = 'Format not supported by the player'; break;
      }
    }
    console.error('[Renderer] Video error:', msg, err);

    // If this was a file that should have been transcoded but wasn't, offer to retry
    if (currentProbeInfo && !wasTranscoded && currentProbeInfo.codec) {
      console.log('[Renderer] Attempting auto-transcode after playback failure...');
      // Force transcode
      currentProbeInfo.needsTranscode = true;
      retryWithTranscode(originalFilePath || currentFilePath);
    }
  });

  async function retryWithTranscode(filePath) {
    if (!filePath) return;
    const codecLabel = (currentProbeInfo && currentProbeInfo.codecFriendly) || 'Unknown codec';
    console.log('[Renderer] Retrying with transcode for:', filePath, codecLabel);

    showTranscodeOverlay(
      'Format not natively supported — transcoding…',
      codecLabel + ' → H.264'
    );

    try {
      const result = await window.electronAPI.transcodeFile(filePath);
      hideTranscodeOverlay();

      if (result && result.error) {
        console.error('[Renderer] Retry transcode failed:', result.error);
        alert('This file could not be played or transcoded.\n\nCodec: ' + codecLabel + '\nError: ' + result.error.substring(0, 300));
        showDropZone();
        return;
      }

      if (result && result.outputPath) {
        console.log('[Renderer] Retry transcode succeeded:', result.outputPath);
        wasTranscoded = true;
        loadVideoFromPath(result.outputPath, filePath.split(/[\\/]/).pop());
      }
    } catch (err) {
      hideTranscodeOverlay();
      console.error('[Renderer] Retry transcode exception:', err);
      alert('Transcoding error:\n\n' + err.message);
      showDropZone();
    }
  }

  // ─── Playback Controls ────────────────────────────────

  function togglePlay() {
    if (!hasVideoLoaded) return;
    if (shuttleDirection !== 0 || (!video.paused && !video.ended)) {
      stopShuttle();
    } else {
      // Normal playback is the 1x forward notch of the shuttle ladder, so a
      // following L steps to 2x rather than restarting at 1x.
      shuttleDirection = 1;
      shuttleSpeed = 1;
      video.playbackRate = 1;
      video.play();
    }
  }

  function seekTo(time) {
    const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration || Infinity;
    const target = Math.max(0, Math.min(duration, time));
    if (streamMode) {
      seekInStream(target);
    } else {
      video.currentTime = target;
    }
    return target;
  }

  function seekRelative(seconds) {
    if (!hasVideoLoaded) return;
    seekTo(video.currentTime + seconds);
  }

  function frameStep(direction) {
    if (!hasVideoLoaded) return;
    stopShuttle();
    const step = direction * frameDuration;
    seekTo(video.currentTime + step);
  }

  // ─── JKL Shuttle (Premiere/FCP-style J/K/L) ────────────

  function stopShuttle() {
    if (shuttleRAF) {
      cancelAnimationFrame(shuttleRAF);
      shuttleRAF = null;
    }
    shuttleLastTs = null;
    shuttleDirection = 0;
    shuttleSpeed = 1;
    video.playbackRate = 1;
    video.pause();
    updatePlayButton(); // reverse shuttle leaves <video> paused, so no pause event fires
  }

  // Speed ladder shared by J and L, matching the Premiere Pro shuttle notches:
  // a press in the direction of travel doubles the speed (1x → 2x → 4x → 8x),
  // a press against it steps one notch back down, and 1x steps straight through
  // to 1x the other way instead of stopping — which is also what Final Cut does
  // from a standing start. K (or Space) is the only thing that stops playback.
  function stepShuttle(dir) {
    if (!hasVideoLoaded) return;
    if (shuttleDirection === dir) {
      shuttleSpeed = Math.min(shuttleSpeed * 2, SHUTTLE_MAX_SPEED);
    } else if (shuttleDirection === 0 || shuttleSpeed <= 1) {
      shuttleDirection = dir;
      shuttleSpeed = 1;
    } else {
      shuttleSpeed = shuttleSpeed / 2; // stepping back toward a stop
    }
    applyShuttle();
  }

  // K held down + J/L is the Premiere/FCP slow shuttle: half speed, no ladder.
  function slowShuttle(dir) {
    if (!hasVideoLoaded) return;
    shuttleDirection = dir;
    shuttleSpeed = 0.5;
    applyShuttle();
  }

  function applyShuttle() {
    if (shuttleDirection === 1) {
      cancelReverseLoop();
      video.playbackRate = shuttleSpeed;
      if (video.paused || video.ended) video.play();
    } else if (shuttleDirection === -1) {
      video.pause(); // <video> has no native reverse playback — driven by rAF
      video.playbackRate = 1;
      startReverseLoop();
    }
    updatePlayButton();
  }

  function shuttleForward() { stepShuttle(1); }
  function shuttleBackward() { stepShuttle(-1); }

  function startReverseLoop() {
    if (shuttleRAF) return; // already running — shuttleSpeed changes are picked up live
    shuttleLastTs = null;
    const tick = (ts) => {
      if (shuttleDirection !== -1) {
        shuttleRAF = null;
        return;
      }
      if (shuttleLastTs !== null) {
        const dt = (ts - shuttleLastTs) / 1000;
        const target = video.currentTime - dt * shuttleSpeed;
        if (target <= 0) {
          seekTo(0);
          stopShuttle();
          return;
        }
        seekTo(target);
      }
      shuttleLastTs = ts;
      shuttleRAF = requestAnimationFrame(tick);
    };
    shuttleRAF = requestAnimationFrame(tick);
  }

  function cancelReverseLoop() {
    if (shuttleRAF) {
      cancelAnimationFrame(shuttleRAF);
      shuttleRAF = null;
    }
    shuttleLastTs = null;
  }

  function setVolume(val) {
    video.volume = Math.max(0, Math.min(1, val));
    video.muted = false;
    volumeSlider.value = video.volume;
    updateVolumeIcon();
  }

  function changeVolume(delta) {
    setVolume(video.volume + delta);
  }

  function toggleMute() {
    if (video.muted || video.volume === 0) {
      video.muted = false;
      if (video.volume === 0) video.volume = lastVolume || 0.5;
      volumeSlider.value = video.volume;
    } else {
      lastVolume = video.volume;
      video.muted = true;
    }
    updateVolumeIcon();
  }

  function updateVolumeIcon() {
    const muted = video.muted || video.volume === 0;
    const low = video.volume < 0.5 && !muted;

    iconVolHigh.classList.toggle('hidden', muted || low);
    iconVolLow.classList.toggle('hidden', muted || !low);
    iconVolMute.classList.toggle('hidden', !muted);
  }

  function toggleFullscreen() {
    window.electronAPI.toggleFullscreen().then((isFs) => {
      iconFsEnter.classList.toggle('hidden', isFs);
      iconFsExit.classList.toggle('hidden', !isFs);
    });
  }

  function jumpToPercent(percent) {
    if (!hasVideoLoaded) return;
    const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
    if (isNaN(duration) || duration <= 0) return;
    const target = duration * percent;
    if (streamMode) {
      seekInStream(target);
    } else {
      video.currentTime = target;
    }
  }

  // ─── UI Updates ───────────────────────────────────────

  function updatePlayButton() {
    // Reverse shuttle drives a paused <video> by hand — still "playing" to the UI.
    const playing = shuttleDirection !== 0 || (!video.paused && !video.ended);
    iconPlay.classList.toggle('hidden', playing);
    iconPause.classList.toggle('hidden', !playing);
    bigPlayBtn.classList.toggle('hidden', playing);
  }

  function updateTimeline() {
    if (!hasVideoLoaded || isTimelineDragging) return;
    const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
    if (isNaN(duration) || duration <= 0) return;
    const progress = (video.currentTime / duration) * 100;
    timelineProgress.style.width = progress + '%';
    timelineThumb.style.left = progress + '%';
  }

  function updateBuffered() {
    if (!hasVideoLoaded) return;
    const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
    if (isNaN(duration) || duration <= 0) return;
    if (video.buffered.length > 0) {
      const bufferedEnd = video.buffered.end(video.buffered.length - 1);
      timelineBuffered.style.width = (bufferedEnd / duration) * 100 + '%';
    }
  }

  function updateTimecode() {
    // Apply source timecode offset so display shows the actual source TC
    timecodeCurrent.textContent = secondsToTimecode(video.currentTime + sourceTimecodeOffset, frameRate);
    const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
    if (!isNaN(duration) && duration > 0) {
      timecodeTotal.textContent = secondsToTimecode(duration + sourceTimecodeOffset, frameRate);
    }
  }

  function startTimecodeUpdater() {
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      const updateFrame = () => {
        updateTimecode();
        updateTimeline();
        video.requestVideoFrameCallback(updateFrame);
      };
      video.requestVideoFrameCallback(updateFrame);
    }
  }

  function animationLoop() {
    if (hasVideoLoaded && !video.paused) {
      updateTimecode();
      updateTimeline();
      checkSelectionPlayback();
    }
    requestAnimationFrame(animationLoop);
  }
  requestAnimationFrame(animationLoop);

  // ─── Controls Auto-Hide ───────────────────────────────

  function showControls() {
    if (!hasVideoLoaded) return;
    controlsBar.classList.remove('hidden');
    controlsBar.classList.add('visible');
    meterHud.classList.remove('controls-hidden');
    document.body.style.cursor = 'default';
    clearTimeout(controlsTimeout);
    if (!video.paused) {
      controlsTimeout = setTimeout(hideControls, 3000);
    }
  }

  function hideControls() {
    if (isTimelineDragging) return;
    controlsBar.classList.remove('visible');
    controlsBar.classList.add('hidden');
    // Fades the meter HUD out alongside the transport rather than hiding it,
    // so the metering loop keeps running and levels are already correct when
    // the mouse comes back.
    meterHud.classList.add('controls-hidden');
    document.body.style.cursor = 'none';
  }

  document.getElementById('video-container').addEventListener('mousemove', showControls);
  document.getElementById('video-container').addEventListener('mouseleave', () => {
    if (!video.paused && hasVideoLoaded) {
      clearTimeout(controlsTimeout);
      controlsTimeout = setTimeout(hideControls, 1500);
    }
  });

  controlsBar.addEventListener('mouseenter', () => clearTimeout(controlsTimeout));
  controlsBar.addEventListener('mouseleave', () => {
    if (!video.paused && hasVideoLoaded) {
      controlsTimeout = setTimeout(hideControls, 2000);
    }
  });

  // ─── Timeline Scrubbing ───────────────────────────────

  function getTimelinePosition(e) {
    const rect = timelineTrack.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  }

  let timelineDragPos = 0; // Track position during drag for stream mode

  timelineContainer.addEventListener('mousedown', (e) => {
    if (!hasVideoLoaded) return;
    isTimelineDragging = true;
    const pos = getTimelinePosition(e);
    timelineDragPos = pos;
    const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
    if (!streamMode && !isNaN(duration)) {
      video.currentTime = pos * duration;
    }
    timelineProgress.style.width = (pos * 100) + '%';
    timelineThumb.style.left = (pos * 100) + '%';
  });

  document.addEventListener('mousemove', (e) => {
    if (isTimelineDragging && hasVideoLoaded) {
      const pos = getTimelinePosition(e);
      timelineDragPos = pos;
      const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
      if (!streamMode && !isNaN(duration)) {
        video.currentTime = pos * duration;
      }
      timelineProgress.style.width = (pos * 100) + '%';
      timelineThumb.style.left = (pos * 100) + '%';
      updateTimecode();
    }
  });

  document.addEventListener('mouseup', () => {
    if (isTimelineDragging && streamMode) {
      // In stream mode, seek on mouse release (not during drag)
      const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
      if (!isNaN(duration) && duration > 0) {
        seekInStream(timelineDragPos * duration);
      }
    }
    isTimelineDragging = false;
  });

  timelineContainer.addEventListener('mousemove', (e) => {
    const duration = (currentProbeInfo && currentProbeInfo.duration) || video.duration;
    if (!hasVideoLoaded || isNaN(duration) || duration <= 0) return;
    const pos = getTimelinePosition(e);
    const time = pos * duration;
    // Apply source timecode offset to tooltip
    timelineTooltip.textContent = secondsToTimecode(time + sourceTimecodeOffset, frameRate);
    timelineTooltip.style.left = (e.clientX - timelineContainer.getBoundingClientRect().left) + 'px';
    timelineTooltip.classList.remove('hidden');
  });

  timelineContainer.addEventListener('mouseleave', () => {
    timelineTooltip.classList.add('hidden');
  });

  // ─── Button Events ────────────────────────────────────

  btnPlay.addEventListener('click', togglePlay);
  bigPlayBtn.addEventListener('click', togglePlay);
  btnSkipBack.addEventListener('click', () => seekRelative(-JUMP_SECONDS));
  btnSkipFwd.addEventListener('click', () => seekRelative(JUMP_SECONDS));
  btnPrevFrame.addEventListener('click', () => frameStep(-1));
  btnNextFrame.addEventListener('click', () => frameStep(1));
  btnLoop.addEventListener('click', () => toggleLoop());
  btnMute.addEventListener('click', toggleMute);
  btnFullscreen.addEventListener('click', toggleFullscreen);
  btnInfo.addEventListener('click', () => togglePanel(fileInfoPanel));

  btnCloseInfo.addEventListener('click', () => fileInfoPanel.classList.add('hidden'));
  btnCloseShortcuts.addEventListener('click', () => shortcutsPanel.classList.add('hidden'));

  volumeSlider.addEventListener('input', () => {
    video.volume = parseFloat(volumeSlider.value);
    video.muted = false;
    updateVolumeIcon();
  });

  video.addEventListener('dblclick', toggleFullscreen);
  video.addEventListener('click', (e) => {
    if (e.detail === 1) {
      setTimeout(() => { if (e.detail === 1) togglePlay(); }, 200);
    }
  });

  function togglePanel(panel) {
    const isHidden = panel.classList.contains('hidden');
    fileInfoPanel.classList.add('hidden');
    shortcutsPanel.classList.add('hidden');
    // The editing panels share the same corner; one at a time.
    document.getElementById('markers-panel').classList.add('hidden');
    document.getElementById('combine-panel').classList.add('hidden');
    document.getElementById('look-panel').classList.add('hidden');
    if (isHidden) panel.classList.remove('hidden');
  }

  // ─── Video Events ─────────────────────────────────────

  video.addEventListener('play', () => {
    if (sdiActive) window.electronAPI.sdiResume();
    updatePlayButton(); showControls(); resyncSecondaryAudio(true);
    // First play is the user gesture that lets an AudioContext start, so the
    // meters are wired up here rather than at load.
    initChannelMeters();
  });
  video.addEventListener('pause', () => {
    if (sdiActive) window.electronAPI.sdiPause();
    updatePlayButton(); showControls(); clearTimeout(controlsTimeout);
    if (secondaryAudio) secondaryAudio.pause();
  });
  video.addEventListener('ended', () => {
    shuttleDirection = 0;
    shuttleSpeed = 1;
    video.playbackRate = 1;

    // Native playback loops via video.loop, which the browser handles without
    // a gap. The streaming path cannot: MediaSource has already been told the
    // stream ended, so restart it from the top instead.
    if (loopEnabled && streamMode) {
      console.log('[Renderer] Loop — restarting stream from the start');
      seekInStream(0).then(() => video.play()).catch((err) => {
        console.warn('[Renderer] Loop restart failed:', err.message);
      });
      return;
    }

    updatePlayButton();
    showControls();
  });
  video.addEventListener('timeupdate', () => {
    updateTimecode(); updateTimeline(); updateBuffered();
    // Playback drains the buffer, so this is where the decoder gets let go again.
    updateStreamBackpressure();
    if (gopVisible) refreshGopStrip();
    updateCaptionOverlay();
    resyncSecondaryAudio();
  });
  video.addEventListener('seeked', () => {
    sdiRestart();
    activeCueIndex = -1;          // a seek can land anywhere in the cue list
    updateCaptionOverlay();
    resyncSecondaryAudio(true);
    drawLutFrame();               // paused + seeked: rVFC will not fire, draw by hand
    renderMarkersPanelActive();
  });
  video.addEventListener('loadedmetadata', () => {
    // New media with a device selected: route it. Dimensions are known now.
    if (sdiDevice) sdiStartForCurrentMedia();
    console.log('[Renderer] Video metadata loaded:', video.videoWidth + 'x' + video.videoHeight, 'duration:', video.duration);
    updateTimecode();
    startTimecodeUpdater();
    updateFileInfoFromVideo();
    masks.redraw();
    updateSelectionUI();
    renderTimelineMarkers();
  });
  video.addEventListener('loadeddata', () => drawLutFrame());
  video.addEventListener('volumechange', updateVolumeIcon);
  video.addEventListener('canplay', () => {
    console.log('[Renderer] Video can play');
  });

  // ─── Drag & Drop ──────────────────────────────────────

  // Keep in sync with VIDEO_EXTENSIONS in main.js.
  const SUPPORTED_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv', '.ogg',
    '.flv', '.wmv', '.mpg', '.mpeg', '.mxf',
    '.ts', '.m2ts', '.mts', '.m2v', '.mpv', '.vob', '.gxf', '.asf', '.mj2',
    '.3gp', '.3g2',
    '.dpx', '.exr', '.tif', '.tiff', '.png', '.jpg', '.jpeg',
  ];

  let dragCounter = 0;

  document.addEventListener('dragenter', (e) => { e.preventDefault(); dragCounter++; dragOverlay.classList.add('visible'); });
  document.addEventListener('dragleave', (e) => { e.preventDefault(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dragOverlay.classList.remove('visible'); } });
  document.addEventListener('dragover', (e) => e.preventDefault());

  document.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.remove('visible');

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      const filePath = files[0].path;
      const ext = '.' + filePath.split('.').pop().toLowerCase();
      if (SUPPORTED_EXTENSIONS.includes(ext)) {
        openFile(filePath);
      } else {
        console.warn('[Renderer] Unsupported extension dropped:', ext);
      }
    }
  });

  // ─── Keyboard Shortcuts ───────────────────────────────

  let kHeld = false; // K held down turns J/L into the slow (half speed) shuttle

  function isTypingTarget(el) {
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ||
      el.tagName === 'SELECT' || el.isContentEditable);
  }

  /**
   * Loop Playback.
   *
   * For everything played natively — including a rendered image sequence,
   * which is the screening-room case — video.loop hands looping to the
   * browser, so it repeats without a gap or a re-decode. The MSE streaming
   * path has no equivalent and is restarted from the 'ended' handler above.
   */
  function toggleLoop(force) {
    loopEnabled = (force === undefined) ? !loopEnabled : !!force;
    video.loop = loopEnabled && !streamMode;
    updateLoopButton();
    console.log('[Renderer] Loop playback:', loopEnabled ? 'on' : 'off');
    sdiRestart();
  }

  // ─── External video output (SDI) ───────────────────────────────────

  function updateSdiBadge(state, detail) {
    if (!sdiBadge) return;
    if (!sdiDevice) { sdiBadge.classList.add('hidden'); return; }
    sdiBadge.classList.remove('hidden', 'warn', 'error');
    const name = sdiDevice.name;
    switch (state) {
      case 'playing':  sdiBadge.textContent = 'SDI ▶ ' + name; break;
      case 'paused':   sdiBadge.textContent = 'SDI ❙❙ ' + name; break;
      case 'underrun': sdiBadge.textContent = 'SDI ▶ ' + name + ' — underrun'; sdiBadge.classList.add('warn'); break;
      case 'error':    sdiBadge.textContent = 'SDI ✕ ' + name; sdiBadge.classList.add('error'); break;
      default:         sdiBadge.textContent = 'SDI: ' + name;
    }
    sdiBadge.title = detail ? String(detail) : 'External video output: ' + name;
  }

  /**
   * Route whatever is loaded to the selected device, from the current
   * position. For an image sequence this decodes the ORIGINAL frames — the
   * H.264 proxy in the <video> element never goes anywhere near the SDI cable.
   */
  async function sdiStartForCurrentMedia() {
    if (!sdiDevice || !originalFilePath) return;
    const fps = frameRate || (currentProbeInfo && currentProbeInfo.fps) || 24;
    const opts = {
      width: video.videoWidth || (currentProbeInfo && currentProbeInfo.width) || 0,
      height: video.videoHeight || (currentProbeInfo && currentProbeInfo.height) || 0,
      fps,
      loop: loopEnabled,
      startPaused: video.paused,
    };
    if (!opts.width || !opts.height) return;   // not loaded yet; loadedmetadata calls again

    if (currentSeqInfo) {
      opts.source = currentSeqInfo.pattern;
      opts.isImageSequence = true;
      opts.startFrame = currentSeqInfo.startFrame + Math.round((video.currentTime || 0) * fps);
      // Where the sequence BEGINS, so a loop can go back to it rather than to
      // wherever playback happened to be when Loop was switched on.
      opts.firstFrame = currentSeqInfo.startFrame;
    } else {
      opts.source = originalFilePath;
      opts.startTime = video.currentTime || 0;
    }

    const r = await window.electronAPI.sdiStart(opts);
    if (r && r.error) {
      sdiActive = false;
      updateSdiBadge('error', r.error);
      console.error('[SDI]', r.error);
      alert('External video output could not start:\n\n' + r.error);
      return;
    }
    sdiActive = true;
    console.log('[SDI] Routing to', r.device, 'as', r.mode);
  }

  /** A seek or a loop change means a fresh decode from a new place. Debounced:
   *  frame-stepping fires 'seeked' per frame, and a restart is not free. */
  function sdiRestart() {
    if (!sdiActive) return;
    clearTimeout(sdiRestartTimer);
    sdiRestartTimer = setTimeout(() => { sdiStartForCurrentMedia(); }, 150);
  }

  function updateLoopButton() {
    if (!btnLoop) return;
    btnLoop.classList.toggle('active', loopEnabled);
    btnLoop.setAttribute('aria-pressed', loopEnabled ? 'true' : 'false');
    btnLoop.title = (loopEnabled ? 'Loop Playback: On' : 'Loop Playback: Off') + ' (⌘L)';
  }

  document.addEventListener('keydown', (e) => {
    if (isTypingTarget(e.target)) return;

    if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      jumpToPercent(parseInt(e.key) / 10);
      return;
    }

    // e.code, not e.key: layout- and Caps Lock-proof, and Space arrives as ' '.
    const mod = e.ctrlKey || e.metaKey || e.altKey;

    // Space also activates whatever button has focus, so a click on the play
    // button followed by Space would toggle twice and look like a dead key.
    if (e.code === 'Space' && !mod) {
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) {
        document.activeElement.blur();
      }
      if (!e.repeat) togglePlay();
      return;
    }

    switch (e.code) {
      // Bare arrows step a frame at a time; Cmd/Ctrl-arrow jumps a second.
      // Frame stepping is the move an operator makes constantly, so it gets
      // the unmodified key.
      case 'ArrowLeft':
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) seekRelative(-JUMP_SECONDS); else frameStep(-1);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) seekRelative(JUMP_SECONDS); else frameStep(1);
        break;
      // Shift+arrows walk the markers (Resolve's binding); bare arrows are volume.
      case 'ArrowUp': e.preventDefault(); if (e.shiftKey) prevMarker(); else changeVolume(0.05); break;
      case 'ArrowDown': e.preventDefault(); if (e.shiftKey) nextMarker(); else changeVolume(-0.05); break;
      // I / O set the selection; Shift+I / Shift+O jump to it. Cmd/Ctrl+I and
      // Cmd/Ctrl+O are registered menu accelerators and never reach here.
      case 'KeyI':
        if (!mod && !e.repeat) { e.preventDefault(); if (e.shiftKey) goToIn(); else setInPoint(); }
        break;
      case 'KeyO':
        if (!mod && !e.repeat) { e.preventDefault(); if (e.shiftKey) goToOut(); else setOutPoint(); }
        break;
      // U toggles the LUT (Cmd/Ctrl+U loads one, via the menu).
      case 'KeyU':
        if (!mod && !e.repeat) { e.preventDefault(); toggleLut(); }
        break;
      // J/K/L ignore auto-repeat: holding L must not run up the speed ladder.
      case 'KeyJ':
        if (!mod && !e.repeat) { e.preventDefault(); if (kHeld) slowShuttle(-1); else shuttleBackward(); }
        break;
      case 'KeyK':
        if (!mod) {
          e.preventDefault();
          if (!e.repeat) { kHeld = true; togglePlay(); }
        }
        break;
      case 'KeyL':
        // Bare L only. Cmd/Ctrl-L for Loop is a REGISTERED menu accelerator
        // (see main.js), and registered accelerators are not also handled
        // here — doing both fires toggleLoop twice and cancels itself out.
        if (!mod && !e.repeat) { e.preventDefault(); if (kHeld) slowShuttle(1); else shuttleForward(); }
        break;
      case 'KeyF': if (!mod) { e.preventDefault(); toggleFullscreen(); } break;
      // M drops a marker at the source timecode — the NLE convention the
      // client asked for. Mute moved to Shift+M; Alt+M deletes the marker
      // under the playhead.
      case 'KeyM':
        if (e.altKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); if (!e.repeat) deleteMarkerAtPlayhead(); }
        else if (!mod) { e.preventDefault(); if (e.shiftKey) toggleMute(); else if (!e.repeat) addMarker(); }
        break;
      case 'Escape':
        fileInfoPanel.classList.add('hidden');
        shortcutsPanel.classList.add('hidden');
        audioPanel.classList.add('hidden');
        hideSequenceDialog();
        closeEditingUi();
        break;
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.code === 'KeyK') kHeld = false;
  });
  // A dropped keyup (window blur mid-hold) would leave K stuck down.
  window.addEventListener('blur', () => { kHeld = false; });

  // ─── IPC from Main Process ────────────────────────────

  window.electronAPI.onOpenFile((filePath) => {
    console.log('[Renderer] IPC: open-file', filePath);
    openFile(filePath);
  });
  window.electronAPI.onOpenImageSequence((filePath) => {
    console.log('[Renderer] IPC: open-image-sequence', filePath);
    tryOpenAsSequence(filePath);
  });

  window.electronAPI.onPlaybackToggle(() => togglePlay());
  window.electronAPI.onToggleLoop(() => toggleLoop());
  window.electronAPI.onSdiDeviceChanged((device) => {
    sdiDevice = device;
    if (!device) {
      sdiActive = false;
      window.electronAPI.sdiStop();
      updateSdiBadge(null);
      console.log('[SDI] Output: built-in display');
      return;
    }
    updateSdiBadge('selected');
    console.log('[SDI] Output device selected:', device.name);
    if (originalFilePath) sdiStartForCurrentMedia();
  });
  window.electronAPI.onSdiStatus((st) => {
    if (!st) return;
    if (st.state === 'ended' || st.state === 'stopped') { sdiActive = false; updateSdiBadge('selected'); return; }
    if (st.state === 'error') { sdiActive = false; }
    updateSdiBadge(st.state, st.detail);
  });
  window.electronAPI.sdiGetState().then((st) => {
    if (st && st.device) { sdiDevice = st.device; updateSdiBadge('selected'); }
  }).catch(() => {});
  window.electronAPI.onShuttle((direction) => stepShuttle(direction));
  window.electronAPI.onToggleGopStrip(() => toggleGopStrip());
  window.electronAPI.onToggleAudioPanel(() => toggleAudioPanel());
  window.electronAPI.onSeekRelative((seconds) => seekRelative(seconds));
  window.electronAPI.onFrameStep((direction) => frameStep(direction));
  window.electronAPI.onVolumeChange((delta) => changeVolume(delta));
  window.electronAPI.onToggleMute(() => toggleMute());
  window.electronAPI.onToggleFileInfo(() => togglePanel(fileInfoPanel));
  window.electronAPI.onShowShortcuts(() => togglePanel(shortcutsPanel));

  window.electronAPI.onSetWindowSize((scale) => {
    if (!hasVideoLoaded || !video.videoWidth || !video.videoHeight) return;
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    window.electronAPI.setWindowSize(Math.max(800, w), Math.max(500, h));
  });

  window.electronAPI.onTranscodeProgress((pct) => updateTranscodeProgress(pct));

  // Stream decode IPC events (v1.1.0)
  window.electronAPI.onStreamData((data) => appendStreamData(data));
  window.electronAPI.onStreamEnd(() => handleStreamEnd());
  window.electronAPI.onStreamError((msg) => handleStreamError(msg));

  // ─── File Info ────────────────────────────────────────

  // Deep ffprobe inspection for the current file; null until it resolves, and
  // stays null when ffprobe is unavailable (the panel falls back to the
  // lightweight playback probe in that case).
  let currentInspection = null;

  async function loadFileInfo(filePath) {
    console.log('[Renderer] Loading file info for:', filePath);
    onMediaChanged(filePath);     // new file: fresh In/Out, this file's markers
    const stats = await window.electronAPI.getFileStats(filePath);
    if (!stats) {
      console.warn('[Renderer] Could not get file stats');
      return;
    }

    const generalGrid = document.getElementById('info-general');
    generalGrid.innerHTML = '';
    addInfoRow(generalGrid, 'File', stats.name);
    addInfoRow(generalGrid, 'Size', formatFileSize(stats.size));
    addInfoRow(generalGrid, 'Format', stats.extension.toUpperCase());
    addInfoRow(generalGrid, 'Location', stats.directory);
    addInfoRow(generalGrid, 'Modified', new Date(stats.modified).toLocaleString());

    updateFileInfoFromVideo();

    // Inspection runs its own ffprobe passes, so let the panel paint first and
    // fill in the deep detail when it lands.
    currentInspection = null;
    // Drop the previous file's channel strips; the next play rebuilds them for
    // whatever this file turns out to carry.
    teardownChannelMeters();
    try {
      const inspection = await window.electronAPI.inspectFile(filePath);
      if (inspection && !inspection.error) {
        currentInspection = inspection;

        // ffprobe's r_frame_rate is authoritative; the stderr scrape in
        // transcoder.js reads the field rate on some containers (GXF reports
        // 50 for 25p), which would double every timecode and frame step.
        const probedRate = inspection.video[0] && inspection.video[0].frameRate;
        if (probedRate && Math.abs(probedRate - frameRate) > 0.01) {
          console.log('[Renderer] Frame rate corrected from', frameRate, 'to', probedRate);
          frameRate = probedRate;
          frameDuration = 1 / frameRate;
          updateTimecode();
        }

        // Now that the real channel count and speaker labels are known, the
        // meters can be rebuilt to match (the first build guesses stereo).
        if (!video.paused) initChannelMeters();
      } else if (inspection && inspection.error) {
        console.warn('[Renderer] Inspection failed:', inspection.error);
      }
    } catch (err) {
      console.warn('[Renderer] Inspection threw:', err.message);
    }
    updateFileInfoFromVideo();
  }

  // ─── Inspector rendering helpers ──────────────────────

  function formatBitrate(bps) {
    if (!bps) return null;
    if (bps >= 1e9) return (bps / 1e9).toFixed(1) + ' Gb/s';
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' Mb/s';
    return Math.round(bps / 1000) + ' kb/s';
  }

  function formatSampleRate(hz) {
    return hz ? (hz / 1000) + ' kHz' : null;
  }

  /**
   * Render the deep-inspection model. Summary sections stay tight; the deep
   * container/HDR/PID descriptors go in the collapsed Advanced section.
   */
  function renderInspection(inspection) {
    const videoGrid = document.getElementById('info-video');
    const audioGrid = document.getElementById('info-audio');
    const capGrid = document.getElementById('info-captions');
    const advGrid = document.getElementById('info-advanced');
    const capSection = document.getElementById('info-section-captions');
    videoGrid.innerHTML = '';
    audioGrid.innerHTML = '';
    capGrid.innerHTML = '';
    advGrid.innerHTML = '';

    const c = inspection.container;

    // ── Video ──
    inspection.video.forEach((v, i) => {
      const prefix = inspection.video.length > 1 ? 'V' + (i + 1) + ' ' : '';
      addInfoRow(videoGrid, prefix + 'Codec', v.codecFriendly);
      if (v.level) addInfoRow(videoGrid, prefix + 'Level', String(v.level / 10));
      addInfoRow(videoGrid, prefix + 'Resolution',
        v.width && v.height ? v.width + ' × ' + v.height : null);
      addInfoRow(videoGrid, prefix + 'Display Aspect', v.displayAspectRatio);
      addInfoRow(videoGrid, prefix + 'Pixel Aspect', v.pixelAspectRatio);
      if (v.cleanAperture) {
        addInfoRow(videoGrid, prefix + 'Clean Aperture',
          v.cleanAperture.width + ' × ' + v.cleanAperture.height +
          ' (' + v.cleanAperture.source + ')');
      } else {
        addInfoRow(videoGrid, prefix + 'Clean Aperture', null);
      }
      addInfoRow(videoGrid, prefix + 'Frame Rate', v.frameRate ? v.frameRate + ' fps' : null);
      addInfoRow(videoGrid, prefix + 'Scan Type', v.scanType);
      addInfoRow(videoGrid, prefix + 'Bit Depth', v.bitDepth ? v.bitDepth + '-bit' : null);
      addInfoRow(videoGrid, prefix + 'Chroma', v.chromaSubsampling);
      addInfoRow(videoGrid, prefix + 'Color Primaries', v.colorPrimaries);
      addInfoRow(videoGrid, prefix + 'Transfer', v.colorTransfer);
      addInfoRow(videoGrid, prefix + 'Matrix', v.colorMatrix);
      addInfoRow(videoGrid, prefix + 'Color Range', v.colorRange);
      if (v.hdrFormat) addInfoRow(videoGrid, prefix + 'HDR', v.hdrFormat);
      addInfoRow(videoGrid, prefix + 'Bitrate', formatBitrate(v.bitrate));
      addInfoRow(videoGrid, prefix + 'GOP',
        v.isIntraOnly ? 'Intra-only (all I-frames)' : 'Long-GOP (B-frames: ' + v.hasBFrames + ')');
    });
    if (!inspection.video.length) addInfoRow(videoGrid, 'Video', 'No video stream');

    // ── Audio ──
    inspection.audio.forEach((a, i) => {
      const prefix = inspection.audio.length > 1 ? 'A' + (i + 1) + ' ' : '';
      addInfoRow(audioGrid, prefix + 'Codec', a.codecFriendly);
      addInfoRow(audioGrid, prefix + 'Channels',
        a.channels ? a.channels + ' (' + (a.channelLayout || 'discrete') + ')' : null);
      addInfoRow(audioGrid, prefix + 'Speakers', a.speakerLabels.join(' · '));
      addInfoRow(audioGrid, prefix + 'Sample Rate', formatSampleRate(a.sampleRate));
      addInfoRow(audioGrid, prefix + 'Bit Depth', a.bitDepth ? a.bitDepth + '-bit' : null);
      addInfoRow(audioGrid, prefix + 'Bitrate', formatBitrate(a.bitrate));
      if (a.language) addInfoRow(audioGrid, prefix + 'Language', a.language);
      if (a.title) addInfoRow(audioGrid, prefix + 'Title', a.title);
    });
    if (!inspection.audio.length) addInfoRow(audioGrid, 'Audio', 'No audio stream');

    // ── Captions / subtitles presence ──
    const hasCaptions = inspection.subtitle.length > 0;
    capSection.classList.toggle('hidden', !hasCaptions);
    inspection.subtitle.forEach((s, i) => {
      const flags = [];
      if (s.isForced) flags.push('forced');
      if (s.isHearingImpaired) flags.push('SDH / hearing impaired');
      if (s.isVisualImpaired) flags.push('visually impaired');
      addInfoRow(capGrid, 'Track ' + (i + 1),
        (s.codecLongName || s.codec) +
        (s.language ? ' · ' + s.language : '') +
        (flags.length ? ' · ' + flags.join(', ') : ''));
    });

    // ── Advanced ──
    addInfoRow(advGrid, 'Container', c.formatLongName || c.formatName);
    addInfoRow(advGrid, 'Overall Bitrate', formatBitrate(c.bitrate));
    addInfoRow(advGrid, 'Start Timecode', c.startTimecode);
    addInfoRow(advGrid, 'Reel Name', c.reelName);
    addInfoRow(advGrid, 'Streams', c.nbStreams != null ? String(c.nbStreams) : null);

    inspection.video.forEach((v, i) => {
      const prefix = inspection.video.length > 1 ? 'V' + (i + 1) + ' ' : 'Video ';
      addInfoRow(advGrid, prefix + 'Pixel Format', v.pixelFormat);
      addInfoRow(advGrid, prefix + 'Codec Tag', v.codecTag);
      addInfoRow(advGrid, prefix + 'Field Order', v.fieldOrder);
      if (v.codedWidth && (v.codedWidth !== v.width || v.codedHeight !== v.height)) {
        addInfoRow(advGrid, prefix + 'Coded Size', v.codedWidth + ' × ' + v.codedHeight);
      }
      if (v.nbFrames) addInfoRow(advGrid, prefix + 'Frame Count', String(v.nbFrames));
      const hdr = v.hdrMetadata;
      if (hdr && hdr.masteringDisplay) {
        const m = hdr.masteringDisplay;
        addInfoRow(advGrid, prefix + 'Mastering Luminance',
          m.minLuminance + ' – ' + m.maxLuminance + ' cd/m²');
        addInfoRow(advGrid, prefix + 'Mastering Primaries',
          'R(' + m.redX + ', ' + m.redY + ') G(' + m.greenX + ', ' + m.greenY + ') ' +
          'B(' + m.blueX + ', ' + m.blueY + ') WP(' + m.whiteX + ', ' + m.whiteY + ')');
      }
      if (hdr && hdr.contentLightLevel) {
        addInfoRow(advGrid, prefix + 'Content Light Level',
          'MaxCLL ' + hdr.contentLightLevel.maxCLL + ' · MaxFALL ' + hdr.contentLightLevel.maxFALL);
      }
    });

    // MPEG-TS program/PID structure
    inspection.programs.forEach((p) => {
      addInfoRow(advGrid, 'Program ' + p.programNum,
        'PMT PID ' + p.pmtPid + ' · PCR PID ' + p.pcrPid +
        ' · streams ' + p.streamIndexes.join(', '));
    });

    // Timecode tracks carried as data streams (MXF, MOV)
    inspection.data.filter((d) => d.isTimecode).forEach((d, i) => {
      addInfoRow(advGrid, 'Timecode Track ' + (i + 1), d.timecode);
    });

    if (inspection.chapters.length) {
      addInfoRow(advGrid, 'Chapters', String(inspection.chapters.length));
    }

    // Container metadata, minus the tags already surfaced above
    const skipTags = ['timecode', 'reel_name'];
    Object.entries(c.tags || {})
      .filter(([k]) => !skipTags.includes(k.toLowerCase()))
      .slice(0, 20)
      .forEach(([k, val]) => addInfoRow(advGrid, k, String(val)));

    if (streamMode) {
      addInfoRow(videoGrid, 'Playback', '⚡ Streaming decode');
    } else if (wasTranscoded) {
      addInfoRow(videoGrid, 'Playback', '✓ Transcoded to H.264');
    }
  }

  function updateFileInfoFromVideo() {
    // Deep inspection supersedes the lightweight playback probe once it lands.
    if (currentInspection) {
      renderInspection(currentInspection);
      return;
    }

    const videoGrid = document.getElementById('info-video');
    videoGrid.innerHTML = '';
    document.getElementById('info-section-captions').classList.add('hidden');
    document.getElementById('info-advanced').innerHTML = '';

    const probe = currentProbeInfo;

    // Show codec info from probe (at the top for prominence)
    if (probe && !probe.error) {
      // We have good probe data
      if (probe.codecFriendly) {
        addInfoRow(videoGrid, 'Codec', probe.codecFriendly);
      } else if (probe.codec) {
        addInfoRow(videoGrid, 'Codec', probe.codec.toUpperCase());
      }
      if (probe.codecProfile && !probe.isProRes && !probe.isDNx) {
        addInfoRow(videoGrid, 'Profile', probe.codecProfile);
      }
    }

    // Always show container if we know it
    if (probe && probe.container) {
      addInfoRow(videoGrid, 'Container', probe.container.toUpperCase());
    }

    // Resolution from the HTML5 video element (or probe)
    const w = video.videoWidth || (probe && probe.width) || 0;
    const h = video.videoHeight || (probe && probe.height) || 0;
    if (w && h) {
      addInfoRow(videoGrid, 'Resolution', w + ' × ' + h);
      addInfoRow(videoGrid, 'Aspect Ratio', getAspectRatio(w, h));
    }

    addInfoRow(videoGrid, 'Frame Rate', frameRate.toFixed(3) + ' fps');

    if (!isNaN(video.duration) && video.duration > 0) {
      addInfoRow(videoGrid, 'Duration', secondsToTimecode(video.duration, frameRate));
    } else if (probe && probe.duration > 0) {
      addInfoRow(videoGrid, 'Duration', secondsToTimecode(probe.duration, frameRate));
    }

    if (probe && probe.bitrate) {
      addInfoRow(videoGrid, 'Bitrate', Math.round(probe.bitrate) + ' kb/s');
    }

    // Source timecode (v1.1.1)
    if (sourceTimecodeStr) {
      addInfoRow(videoGrid, 'Source TC Start', sourceTimecodeStr);
    }

    if (streamMode) {
      addInfoRow(videoGrid, 'Playback', '⚡ Streaming decode');
    } else if (wasTranscoded) {
      addInfoRow(videoGrid, 'Playback', '✓ Transcoded to H.264');
    }

    // Show a warning if probe failed
    if (probe && probe.probeFailedMessage) {
      addInfoRow(videoGrid, '⚠ Note', 'Codec detection unavailable');
    }

    // Audio section
    const audioGrid = document.getElementById('info-audio');
    audioGrid.innerHTML = '';
    if (probe && !probe.error && probe.audioFriendly) {
      addInfoRow(audioGrid, 'Codec', probe.audioFriendly);
      if (probe.audioDetails) {
        addInfoRow(audioGrid, 'Details', probe.audioDetails);
      }
    } else if (probe && !probe.error && probe.audioCodec) {
      addInfoRow(audioGrid, 'Codec', probe.audioCodec.toUpperCase());
    } else {
      // Fallback: check if the video element reports audio tracks
      const hasAudio = video.mozHasAudio || video.webkitAudioDecodedByteCount > 0 ||
                       (video.audioTracks && video.audioTracks.length > 0);
      addInfoRow(audioGrid, 'Audio', hasAudio ? 'Present' : 'None');
    }
  }

  video.addEventListener('loadedmetadata', () => updateFileInfoFromVideo());

  function addInfoRow(container, label, value) {
    const labelEl = document.createElement('span');
    labelEl.className = 'info-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    const absent = value === null || value === undefined || value === '';
    // Absent properties read as an em dash rather than vanishing, so the panel
    // distinguishes "not in this file" from "we didn't look".
    valueEl.className = absent ? 'info-value info-value-absent' : 'info-value';
    valueEl.textContent = absent ? '—' : value;
    container.appendChild(labelEl);
    container.appendChild(valueEl);
  }

  function getAspectRatio(w, h) {
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const d = gcd(w, h);
    return (w / d) + ':' + (h / d);
  }

  // ─── Captions & Secondary Files (§3, §5) ──────────────
  //
  // Both features hang off the primary timeline clock: captions are cues keyed
  // to it, secondary audio is an <audio> element slaved to it. They share one
  // offset control so an operator can nudge either into alignment and confirm
  // sync against picture.

  const captionOverlay = document.getElementById('caption-overlay');
  const captionText = document.getElementById('caption-text');
  const syncBar = document.getElementById('sync-bar');
  const syncSource = document.getElementById('sync-source');
  const syncOffsetInput = document.getElementById('sync-offset-value');
  const syncOffsetMs = document.getElementById('sync-offset-ms');
  const btnOffsetMinus = document.getElementById('btn-offset-minus');
  const btnOffsetPlus = document.getElementById('btn-offset-plus');
  const btnToggleCaptions = document.getElementById('btn-toggle-captions');
  const btnClearSync = document.getElementById('btn-clear-sync');

  let captionTrack = null;      // { format, cues, path }
  let captionsVisible = true;
  let activeCueIndex = -1;
  let syncOffsetFrames = 0;     // applies to captions and secondary audio alike
  let secondaryAudio = null;    // HTMLAudioElement slaved to the video clock

  function syncOffsetSeconds() {
    return syncOffsetFrames * frameDuration;
  }

  function updateSyncBar() {
    const active = captionTrack || secondaryAudio;
    syncBar.classList.toggle('hidden', !active);
    if (!active) return;

    const parts = [];
    if (captionTrack) {
      parts.push(captionTrack.format + ' · ' + captionTrack.cues.length + ' cues');
    }
    if (secondaryAudio) {
      parts.push('Secondary audio: ' + secondaryAudio.dataset.name);
    }
    syncSource.textContent = parts.join('  |  ');

    syncOffsetInput.value = String(syncOffsetFrames);
    syncOffsetMs.textContent = (syncOffsetSeconds() * 1000).toFixed(1) + ' ms';
    btnToggleCaptions.classList.toggle('hidden', !captionTrack);
    btnToggleCaptions.textContent = captionsVisible ? 'Hide Captions' : 'Show Captions';
  }

  /**
   * Find and render the cue covering the current time. Cues are sorted, so a
   * linear scan from the last hit is enough — this runs on every timeupdate.
   */
  function updateCaptionOverlay() {
    if (!captionTrack || !captionsVisible) {
      captionOverlay.classList.add('hidden');
      return;
    }

    // A positive offset means the captions should appear LATER, so look up the
    // cue list at an earlier time.
    const t = video.currentTime - syncOffsetSeconds();
    const cues = captionTrack.cues;

    let index = -1;
    for (let i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t <= cues[i].end) { index = i; break; }
      if (cues[i].start > t) break;   // sorted — nothing further can match
    }

    if (index === activeCueIndex) return;
    activeCueIndex = index;

    if (index === -1) {
      captionOverlay.classList.add('hidden');
      captionText.textContent = '';
    } else {
      captionText.textContent = cues[index].text;
      captionOverlay.classList.remove('hidden');
    }
  }

  function setSyncOffset(frames) {
    syncOffsetFrames = frames;
    activeCueIndex = -1;          // force the overlay to re-evaluate
    if (secondaryAudio) resyncSecondaryAudio(true);
    updateCaptionOverlay();
    updateSyncBar();
  }

  btnOffsetMinus.addEventListener('click', () => setSyncOffset(syncOffsetFrames - 1));
  btnOffsetPlus.addEventListener('click', () => setSyncOffset(syncOffsetFrames + 1));
  syncOffsetInput.addEventListener('change', () => {
    const v = parseInt(syncOffsetInput.value, 10);
    setSyncOffset(isFinite(v) ? v : 0);
  });

  btnToggleCaptions.addEventListener('click', () => {
    captionsVisible = !captionsVisible;
    activeCueIndex = -1;
    updateCaptionOverlay();
    updateSyncBar();
  });

  btnClearSync.addEventListener('click', () => {
    captionTrack = null;
    activeCueIndex = -1;
    captionOverlay.classList.add('hidden');
    detachSecondaryAudio();
    syncOffsetFrames = 0;
    updateSyncBar();
  });

  async function loadCaptionSidecar() {
    const filePath = await window.electronAPI.openCaptionDialog();
    if (!filePath) return;

    const result = await window.electronAPI.loadCaptionFile(filePath, frameRate);
    if (result.error) {
      alert('Could not load captions:\n\n' + result.error);
      return;
    }
    captionTrack = result;
    captionsVisible = true;
    activeCueIndex = -1;
    console.log('[Renderer] Loaded', result.cues.length, 'cues from', result.format);
    updateCaptionOverlay();
    updateSyncBar();
  }

  async function loadEmbeddedCaptions() {
    const source = originalFilePath || currentFilePath;
    if (!source) return;

    const result = await window.electronAPI.extractEmbeddedCaptions(source);
    if (result.error) {
      alert(result.error);
      return;
    }
    captionTrack = result;
    captionsVisible = true;
    activeCueIndex = -1;
    updateCaptionOverlay();
    updateSyncBar();
  }

  // ── Secondary audio (§5) ──

  function detachSecondaryAudio() {
    if (!secondaryAudio) return;
    secondaryAudio.pause();
    secondaryAudio.src = '';
    secondaryAudio = null;
  }

  /**
   * Keep the secondary track locked to the primary clock. Small drift is
   * corrected by nudging currentTime; anything past the threshold is a hard
   * reseek (which is what a user scrub looks like).
   */
  const SECONDARY_DRIFT_TOLERANCE = 0.08;   // seconds

  function resyncSecondaryAudio(force) {
    if (!secondaryAudio) return;
    const target = video.currentTime - syncOffsetSeconds();
    if (target < 0) { secondaryAudio.pause(); return; }

    if (force || Math.abs(secondaryAudio.currentTime - target) > SECONDARY_DRIFT_TOLERANCE) {
      secondaryAudio.currentTime = target;
    }
    secondaryAudio.playbackRate = video.playbackRate;

    const shouldPlay = !video.paused && !video.ended && shuttleDirection !== -1;
    if (shouldPlay && secondaryAudio.paused) secondaryAudio.play().catch(() => {});
    if (!shouldPlay && !secondaryAudio.paused) secondaryAudio.pause();
  }

  async function loadSecondaryAudio() {
    const filePath = await window.electronAPI.openSecondaryAudioDialog();
    if (!filePath) return;

    detachSecondaryAudio();
    const audio = new Audio();
    audio.src = 'file://' + filePath.replace(/\\/g, '/');
    audio.dataset.name = filePath.split(/[\\/]/).pop();
    audio.preload = 'auto';

    audio.addEventListener('error', () => {
      alert('Could not load secondary audio — the format may need transcoding first.');
      detachSecondaryAudio();
      updateSyncBar();
    });

    secondaryAudio = audio;
    resyncSecondaryAudio(true);
    updateSyncBar();
  }

  window.electronAPI.onLoadCaptionFile(() => loadCaptionSidecar());
  window.electronAPI.onExtractEmbeddedCaptions(() => loadEmbeddedCaptions());
  window.electronAPI.onLoadSecondaryAudio(() => loadSecondaryAudio());

  // ─── Audio Meters & Loudness (§6) ─────────────────────
  //
  // Two separate things share this panel:
  //   • Live per-channel meters, driven by Web Audio off the playing element.
  //     These are indicative — rAF sampling means they see most, not all, of
  //     the signal.
  //   • Offline program loudness, measured by ffmpeg's ebur128 over the whole
  //     file. That is the spec-grade number a QC operator signs off on.

  const audioPanel = document.getElementById('audio-panel');
  const meterRack = document.getElementById('meter-rack');
  const loudnessResults = document.getElementById('loudness-results');
  const loudnessProgress = document.getElementById('loudness-progress');
  const loudnessProgressBar = document.getElementById('loudness-progress-bar');
  const btnAnalyzeLoudness = document.getElementById('btn-analyze-loudness');
  const btnCloseAudio = document.getElementById('btn-close-audio');
  const loudnessTargetSel = document.getElementById('loudness-target');
  const loudnessGatingSel = document.getElementById('loudness-gating');

  const meterHud = document.getElementById('meter-hud');
  const meterHudBars = document.getElementById('meter-hud-bars');
  const meterHudLabels = document.getElementById('meter-hud-labels');
  const meterHudLabel = document.getElementById('meter-hud-label');

  let audioCtx = null;
  let meterSourceNode = null;  // MediaElementAudioSourceNode (not the MSE MediaSource)
  // One entry per channel, each feeding BOTH the always-on HUD and the panel.
  let channelStrips = [];
  let meterRAF = null;
  let meterChannelCount = 0;   // what the current graph was built for

  /**
   * Build the metering graph:
   *   <video> → splitter → [per-channel gain → analyser] → merger → destination
   * Created once — a MediaElementAudioSourceNode can only be made once per
   * element, and re-creating it would silence playback.
   */
  function ensureAudioGraph() {
    if (audioCtx) return true;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      meterSourceNode = audioCtx.createMediaElementSource(video);
      return true;
    } catch (err) {
      console.warn('[Renderer] Could not create audio graph:', err.message);
      audioCtx = null;
      return false;
    }
  }

  function buildMeters(channelCount, labels) {
    if (!ensureAudioGraph()) return;

    // Tear down any previous routing before re-wiring for a new channel count.
    try { meterSourceNode.disconnect(); } catch (_) { /* not connected yet */ }
    channelStrips.forEach((s) => {
      try { s.gain.disconnect(); s.analyser.disconnect(); } catch (_) { /* ignore */ }
    });
    channelStrips = [];
    meterRack.innerHTML = '';
    meterHudBars.innerHTML = '';
    meterHudLabels.innerHTML = '';

    const count = Math.max(1, Math.min(channelCount || 2, 32));
    meterChannelCount = count;
    const splitter = audioCtx.createChannelSplitter(count);
    const merger = audioCtx.createChannelMerger(count);
    meterSourceNode.connect(splitter);

    for (let i = 0; i < count; i++) {
      const gain = audioCtx.createGain();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;

      splitter.connect(gain, i);
      gain.connect(analyser);
      gain.connect(merger, 0, i);

      const strip = document.createElement('div');
      strip.className = 'meter-strip';
      const bar = document.createElement('div');
      bar.className = 'meter-bar';
      const fill = document.createElement('div');
      fill.className = 'meter-fill';
      const peakLine = document.createElement('div');
      peakLine.className = 'meter-peak';
      bar.appendChild(fill);
      bar.appendChild(peakLine);

      const label = document.createElement('span');
      label.className = 'meter-label';
      label.textContent = (labels && labels[i]) || 'Ch ' + (i + 1);

      const value = document.createElement('span');
      value.className = 'meter-value';
      value.textContent = '−∞';

      const btns = document.createElement('div');
      btns.className = 'meter-btns';
      const btnMute = document.createElement('button');
      btnMute.textContent = 'M';
      btnMute.title = 'Mute this channel';
      const btnSolo = document.createElement('button');
      btnSolo.textContent = 'S';
      btnSolo.title = 'Solo this channel';
      btns.appendChild(btnMute);
      btns.appendChild(btnSolo);

      strip.appendChild(bar);
      strip.appendChild(label);
      strip.appendChild(value);
      strip.appendChild(btns);
      meterRack.appendChild(strip);

      // Same channel, second view: a thin bar in the always-on HUD.
      const hudChannel = document.createElement('div');
      hudChannel.className = 'hud-channel';
      hudChannel.title = (labels && labels[i]) || 'Ch ' + (i + 1);
      const hudFill = document.createElement('div');
      hudFill.className = 'hud-fill';
      const hudPeak = document.createElement('div');
      hudPeak.className = 'hud-peak';
      hudChannel.appendChild(hudFill);
      hudChannel.appendChild(hudPeak);
      meterHudBars.appendChild(hudChannel);

      const hudName = document.createElement('div');
      hudName.className = 'hud-channel-name';
      hudName.textContent = (labels && labels[i]) || String(i + 1);
      meterHudLabels.appendChild(hudName);

      const stripState = {
        index: i, gain, analyser, muted: false, soloed: false,
        els: { fill, peakLine, value, btnMute, btnSolo },
        hud: { channel: hudChannel, fill: hudFill, peak: hudPeak },
        peakHold: 0, peakHoldAt: 0,
      };
      btnMute.addEventListener('click', () => {
        stripState.muted = !stripState.muted;
        btnMute.classList.toggle('active', stripState.muted);
        applyChannelRouting();
      });
      btnSolo.addEventListener('click', () => {
        stripState.soloed = !stripState.soloed;
        btnSolo.classList.toggle('active', stripState.soloed);
        applyChannelRouting();
      });
      channelStrips.push(stripState);
    }

    merger.connect(audioCtx.destination);

    meterHudLabel.textContent = describeAudioLayout(count);
    meterHud.classList.remove('hidden');

    applyChannelRouting();
    startMeterLoop();
  }

  /**
   * Total audio channels the FILE carries, across every track. Pro masters
   * routinely split audio into discrete mono tracks — a stereo pair as two
   * monos, 5.1 as six — and reading only the first track reports "1 CH" for
   * what is really a stereo programme.
   */
  function totalFileChannels() {
    if (!currentInspection || !currentInspection.audio.length) return 0;
    return currentInspection.audio.reduce((sum, a) => sum + (a.channels || 0), 0);
  }

  /**
   * Per-channel captions. A single multichannel track uses its own speaker
   * labels; separate mono tracks are named by track, except a plain pair which
   * is by convention the L/R of a stereo programme.
   */
  function channelNames(count) {
    if (!currentInspection || !currentInspection.audio.length) {
      return Array.from({ length: count }, (_, i) => String(i + 1));
    }
    const tracks = currentInspection.audio;
    if (tracks.length === 1) return tracks[0].speakerLabels.slice(0, count);
    if (tracks.length === 2 && tracks.every((t) => t.channels === 1)) return ['L', 'R'];

    const names = [];
    tracks.forEach((t, ti) => {
      if (t.channels === 1) names.push('T' + (ti + 1));
      else t.speakerLabels.forEach((l) => names.push(l));
    });
    return names.slice(0, count);
  }

  /** Human-readable summary of the audio layout, shown under the meters. */
  function describeAudioLayout(count) {
    const tracks = (currentInspection && currentInspection.audio) || [];

    if (tracks.length > 1 && tracks.every((t) => t.channels === 1)) {
      // Two discrete monos is how a stereo pair is normally delivered.
      return tracks.length === 2 ? '2 × MONO (PAIR)' : tracks.length + ' × MONO';
    }
    if (tracks.length === 1 && tracks[0].channelLayout) {
      return tracks[0].channelLayout.toUpperCase();
    }
    if (count === 1) return 'MONO';
    if (count === 2) return 'STEREO';
    return count + ' CH';
  }

  /**
   * Bring the meters up for the current file. Deferred until playback starts
   * because creating a MediaElementAudioSourceNode routes ALL audio through
   * the graph — do that against a suspended AudioContext and playback goes
   * silent. The first play is a user gesture, so the context can resume.
   */
  function initChannelMeters() {
    if (!hasVideoLoaded) return;

    if (currentInspection && !currentInspection.audio.length) {
      // Inspected and definitively has no audio — keep the HUD out of the way.
      meterHud.classList.add('hidden');
      return;
    }

    // Count every track, not just the first: the decoder now merges discrete
    // mono tracks into one stream, so all of them are audible and meterable.
    const count = Math.max(1, Math.min(totalFileChannels() || 2, 8));
    if (channelStrips.length && count === meterChannelCount) return;  // already built

    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    buildMeters(count, channelNames(count));
  }

  function teardownChannelMeters() {
    channelStrips.forEach((s) => {
      try { s.gain.disconnect(); s.analyser.disconnect(); } catch (_) { /* ignore */ }
    });
    channelStrips = [];
    meterChannelCount = 0;
    meterHudBars.innerHTML = '';
    meterHudLabels.innerHTML = '';
    meterRack.innerHTML = '';
    meterHud.classList.add('hidden');
  }

  // Solo wins over mute: if anything is soloed, only soloed channels are heard.
  function applyChannelRouting() {
    const anySoloed = channelStrips.some((s) => s.soloed);
    for (const s of channelStrips) {
      const audible = anySoloed ? s.soloed : !s.muted;
      s.gain.gain.value = audible ? 1 : 0;
    }
  }

  function amplitudeToDb(amp) {
    return amp > 0 ? 20 * Math.log10(amp) : -Infinity;
  }

  // -60 dBFS at the bottom of the bar, 0 dBFS at the top.
  function dbToMeterFraction(db) {
    if (!isFinite(db)) return 0;
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  function startMeterLoop() {
    if (meterRAF) return;
    const buf = new Float32Array(2048);

    const tick = () => {
      const panelOpen = !audioPanel.classList.contains('hidden');
      // The HUD is faded with opacity rather than display, so its own hidden
      // class is what says "no audio here", not whether the controls are up.
      const hudLive = !meterHud.classList.contains('hidden');

      if (channelStrips.length && (panelOpen || hudLive)) {
        const now = performance.now();
        for (const s of channelStrips) {
          s.analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          let sumSquares = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i]);
            if (v > peak) peak = v;
            sumSquares += buf[i] * buf[i];
          }
          const rms = Math.sqrt(sumSquares / buf.length);
          const peakDb = amplitudeToDb(peak);
          const rmsDb = amplitudeToDb(rms);
          const rmsPct = dbToMeterFraction(rmsDb) * 100;

          // Peak hold decays after 1.5s rather than sticking forever.
          if (peakDb > s.peakHold || now - s.peakHoldAt > 1500) {
            s.peakHold = peakDb;
            s.peakHoldAt = now;
          }
          const peakPct = dbToMeterFraction(s.peakHold) * 100;
          const clipped = peakDb > -0.1;

          if (hudLive) {
            s.hud.fill.style.height = rmsPct + '%';
            s.hud.peak.style.bottom = peakPct + '%';
            s.hud.channel.classList.toggle('clipped', clipped);
          }

          if (panelOpen) {
            s.els.fill.style.height = rmsPct + '%';
            s.els.fill.classList.toggle('over', clipped);
            s.els.peakLine.style.bottom = peakPct + '%';
            s.els.value.textContent = isFinite(s.peakHold) ? s.peakHold.toFixed(1) : '−∞';
          }
        }
      }
      meterRAF = requestAnimationFrame(tick);
    };
    meterRAF = requestAnimationFrame(tick);
  }

  function toggleAudioPanel() {
    const wasHidden = audioPanel.classList.contains('hidden');
    fileInfoPanel.classList.add('hidden');
    shortcutsPanel.classList.add('hidden');
    audioPanel.classList.toggle('hidden', !wasHidden);

    if (wasHidden) {
      // A user gesture is required before an AudioContext may start.
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      initChannelMeters();
    }
  }

  btnCloseAudio.addEventListener('click', () => audioPanel.classList.add('hidden'));

  btnAnalyzeLoudness.addEventListener('click', async () => {
    const source = originalFilePath || currentFilePath;
    if (!source) return;

    btnAnalyzeLoudness.disabled = true;
    btnAnalyzeLoudness.textContent = 'Analyzing…';
    loudnessProgress.classList.remove('hidden');
    loudnessProgressBar.style.width = '0%';
    loudnessResults.innerHTML = '';

    try {
      const measurement = await window.electronAPI.measureLoudness(source, {
        gated: loudnessGatingSel.value === 'gated',
        duration: (currentInspection && currentInspection.container.duration) || video.duration || 0,
      });

      if (measurement.error) {
        addInfoRow(loudnessResults, 'Error', measurement.error);
        return;
      }

      const verdict = await window.electronAPI.checkLoudnessTarget(
        measurement, loudnessTargetSel.value);

      addInfoRow(loudnessResults, 'Integrated',
        measurement.integrated + ' ' + (loudnessTargetSel.value === 'atsc-a85' ? 'LKFS' : 'LUFS'));
      addInfoRow(loudnessResults, 'Loudness Range (LRA)',
        measurement.loudnessRange !== null ? measurement.loudnessRange + ' LU' : null);
      addInfoRow(loudnessResults, 'Max True Peak',
        measurement.truePeak !== null ? measurement.truePeak + ' dBTP' : null);
      addInfoRow(loudnessResults, 'Gating',
        measurement.gated ? 'Gated (BS.1770-3/-4)' : 'Ungated (BS.1770-2)');

      if (verdict && !verdict.error) {
        for (const check of verdict.checks) {
          const row = document.createElement('span');
          row.className = 'info-label';
          row.textContent = check.name;
          const val = document.createElement('span');
          val.className = 'info-value loudness-' + (check.pass ? 'pass' : 'fail');
          val.textContent = (check.pass ? '✓ PASS' : '✗ FAIL') + ' — ' + check.detail;
          loudnessResults.appendChild(row);
          loudnessResults.appendChild(val);
        }
        const overall = document.createElement('span');
        overall.className = 'info-label';
        overall.textContent = verdict.target;
        const overallVal = document.createElement('span');
        overallVal.className = 'info-value loudness-' + (verdict.pass ? 'pass' : 'fail');
        overallVal.textContent = verdict.pass ? '✓ MEETS SPEC' : '✗ OUT OF SPEC';
        loudnessResults.appendChild(overall);
        loudnessResults.appendChild(overallVal);
      }
    } catch (err) {
      addInfoRow(loudnessResults, 'Error', err.message);
    } finally {
      btnAnalyzeLoudness.disabled = false;
      btnAnalyzeLoudness.textContent = 'Analyze';
      loudnessProgress.classList.add('hidden');
    }
  });

  window.electronAPI.onLoudnessProgress((pct) => {
    loudnessProgressBar.style.width = Math.round(pct * 100) + '%';
  });

  // ─── GOP / Data-Rate Strip ────────────────────────────
  //
  // Reading per-frame picture types means walking the bitstream, so the strip
  // only ever covers a bounded window around the playhead and refetches when
  // the playhead leaves it.

  const GOP_WINDOW_SECONDS = 10;
  const gopContainer = document.getElementById('gop-strip-container');
  const gopCanvas = document.getElementById('gop-strip');
  const gopStatus = document.getElementById('gop-status');
  const gopCtx = gopCanvas.getContext('2d');

  const GOP_COLORS = { I: '#ff9f43', P: '#e612c5', B: '#8e8e93' };

  let gopVisible = false;
  let gopFrames = [];
  let gopWindowStart = 0;
  let gopWindowEnd = 0;
  let gopLoading = false;

  function toggleGopStrip() {
    gopVisible = !gopVisible;
    gopContainer.classList.toggle('hidden', !gopVisible);
    if (gopVisible) {
      gopFrames = [];
      gopWindowStart = gopWindowEnd = 0;
      refreshGopStrip();
    }
  }

  async function refreshGopStrip(force) {
    if (!gopVisible || !hasVideoLoaded || gopLoading) return;
    const probeSource = originalFilePath || currentFilePath;
    if (!probeSource) return;

    const t = video.currentTime;
    // Refetch once the playhead is inside the last 20% of the loaded window.
    const margin = GOP_WINDOW_SECONDS * 0.2;
    if (!force && gopFrames.length && t >= gopWindowStart && t <= gopWindowEnd - margin) {
      drawGopStrip();
      return;
    }

    const start = Math.max(0, t - GOP_WINDOW_SECONDS / 4);
    gopLoading = true;
    gopStatus.textContent = 'Analyzing…';
    try {
      const frames = await window.electronAPI.probeFrames(probeSource, start, GOP_WINDOW_SECONDS);
      if (frames && frames.error) {
        gopStatus.textContent = 'Frame analysis failed';
        gopFrames = [];
      } else {
        gopFrames = (frames || []).filter((f) => f.time !== null);
        gopWindowStart = start;
        gopWindowEnd = start + GOP_WINDOW_SECONDS;
      }
    } catch (err) {
      console.warn('[Renderer] GOP probe failed:', err.message);
      gopStatus.textContent = 'Frame analysis failed';
      gopFrames = [];
    } finally {
      gopLoading = false;
    }
    drawGopStrip();
  }

  function drawGopStrip() {
    // Canvas is laid out by CSS; match the backing store to it (and to DPR) or
    // the strip renders blurry and the click-to-seek mapping goes off.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = gopCanvas.clientWidth || 800;
    const cssHeight = 46;
    if (gopCanvas.width !== Math.round(cssWidth * dpr)) {
      gopCanvas.width = Math.round(cssWidth * dpr);
      gopCanvas.height = Math.round(cssHeight * dpr);
    }
    gopCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gopCtx.clearRect(0, 0, cssWidth, cssHeight);

    if (!gopFrames.length) {
      gopStatus.textContent = gopLoading ? 'Analyzing…' : 'No frame data';
      return;
    }

    const span = gopWindowEnd - gopWindowStart;
    const tickHeight = 14;
    const curveTop = tickHeight + 2;
    const curveHeight = cssHeight - curveTop;
    const maxSize = Math.max(...gopFrames.map((f) => f.size || 0), 1);

    // Picture-type ticks
    for (const f of gopFrames) {
      const x = ((f.time - gopWindowStart) / span) * cssWidth;
      const w = Math.max(1.5, cssWidth / (gopFrames.length * 1.4));
      gopCtx.fillStyle = GOP_COLORS[f.pictType] || '#555';
      gopCtx.fillRect(x, 0, w, tickHeight);
    }

    // Per-frame data-rate curve
    gopCtx.beginPath();
    gopFrames.forEach((f, i) => {
      const x = ((f.time - gopWindowStart) / span) * cssWidth;
      const y = curveTop + curveHeight - ((f.size || 0) / maxSize) * curveHeight;
      if (i === 0) gopCtx.moveTo(x, y); else gopCtx.lineTo(x, y);
    });
    gopCtx.strokeStyle = 'rgba(255,255,255,0.55)';
    gopCtx.lineWidth = 1;
    gopCtx.stroke();

    // Playhead
    const px = ((video.currentTime - gopWindowStart) / span) * cssWidth;
    if (px >= 0 && px <= cssWidth) {
      gopCtx.fillStyle = '#fff';
      gopCtx.fillRect(px - 0.5, 0, 1, cssHeight);
    }

    const counts = gopFrames.reduce((acc, f) => {
      acc[f.pictType] = (acc[f.pictType] || 0) + 1;
      return acc;
    }, {});
    const avgKb = Math.round(
      gopFrames.reduce((s, f) => s + (f.size || 0), 0) / gopFrames.length / 1024);
    gopStatus.textContent =
      gopFrames.length + ' frames · I ' + (counts.I || 0) +
      ' / P ' + (counts.P || 0) + ' / B ' + (counts.B || 0) +
      ' · peak ' + Math.round(maxSize / 1024) + ' kB · avg ' + avgKb + ' kB';
  }

  // Click a tick to seek to that exact frame.
  gopCanvas.addEventListener('click', (e) => {
    if (!gopFrames.length) return;
    const rect = gopCanvas.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const targetTime = gopWindowStart + ratio * (gopWindowEnd - gopWindowStart);
    // Snap to the nearest analyzed frame so the seek lands on a real frame.
    let nearest = gopFrames[0];
    for (const f of gopFrames) {
      if (Math.abs(f.time - targetTime) < Math.abs(nearest.time - targetTime)) nearest = f;
    }
    stopShuttle();
    seekTo(nearest.time);
    drawGopStrip();
  });

  window.addEventListener('resize', () => { if (gopVisible) drawGopStrip(); });

  // ═══════════════════════════════════════════════════════════════════════
  //  QuickTime 7 Pro-style editing
  //
  //  In/Out selection → Trim / Delete / Copy-to-bin / Export, markers on M,
  //  Append & Combine Movies, Save Current Frame, audio extract / remove /
  //  replace / add / mute. Every operation writes a NEW file through
  //  src/editor.js in the main process; the loaded media is never changed.
  //  Lossless (stream copy) is the default wherever the source allows it.
  // ═══════════════════════════════════════════════════════════════════════

  const btnSetIn = document.getElementById('btn-set-in');
  const btnSetOut = document.getElementById('btn-set-out');
  const btnAddMarker = document.getElementById('btn-add-marker');
  const btnSaveFrame = document.getElementById('btn-save-frame');
  const btnLook = document.getElementById('btn-look');
  const timelineRange = document.getElementById('timeline-range');
  const timelineIn = document.getElementById('timeline-in');
  const timelineOut = document.getElementById('timeline-out');
  const timelineMarkers = document.getElementById('timeline-markers');
  const editBar = document.getElementById('edit-bar');
  const editInEl = document.getElementById('edit-in');
  const editOutEl = document.getElementById('edit-out');
  const editDurEl = document.getElementById('edit-dur');
  const editNoteEl = document.getElementById('edit-note');

  let inPoint = null;              // media seconds, or null
  let outPoint = null;
  let playingSelection = false;    // Play In→Out is running; stop (or loop) at Out
  let editPresets = null;          // { encode: [...], stills: [...] } from main
  let editDesc = null;             // editor.describeSource() of the current media
  let editDescFor = null;          // which path editDesc describes

  function mediaDuration() {
    return (currentProbeInfo && currentProbeInfo.duration) || video.duration || 0;
  }

  /** Source timecode of a media time, as shown everywhere else in the UI. */
  function tcOf(t) {
    return secondsToTimecode(t + sourceTimecodeOffset, frameRate);
  }

  /** Timecode made safe for a filename: 01:00:04:12 → 01.00.04.12 */
  function tcForName(t) {
    return tcOf(t).replace(/[:;]/g, '.');
  }

  function snapToFrame(t) {
    return Math.round(t * frameRate) / frameRate;
  }

  function baseName(p) {
    return (p || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  }

  function dirName(p) {
    const parts = (p || '').split(/[\\/]/);
    parts.pop();
    return parts.join(p && p.includes('\\') ? '\\' : '/');
  }

  function joinPath(dir, name) {
    if (!dir) return name;
    return dir + (dir.includes('\\') ? '\\' : '/') + name;
  }

  /**
   * The current media as an editor source. Image sequences are passed as
   * their pattern (edits then decode the ORIGINAL frames, never the H.264
   * proxy); .braw has no ffmpeg demuxer and is refused with a clear message.
   */
  function currentEditSource() {
    if (!hasVideoLoaded) { alert('Open a movie first.'); return null; }
    if (currentProbeInfo && currentProbeInfo.isBraw) {
      alert('Editing operations are not available for Blackmagic RAW yet — the bundled ffmpeg cannot read .braw directly.');
      return null;
    }
    if (currentSeqInfo) {
      return {
        isImageSequence: true,
        pattern: currentSeqInfo.pattern,
        startFrame: currentSeqInfo.startFrame,
        count: currentSeqInfo.count,
        fps: frameRate,
        path: currentSeqInfo.sampleFile,
      };
    }
    if (!originalFilePath) { alert('Open a movie first.'); return null; }
    return { path: originalFilePath, fps: frameRate };
  }

  /** Where new files default to: next to the source, named after it. */
  function defaultOutput(suffix, ext) {
    const src = currentSeqInfo ? currentSeqInfo.sampleFile : (originalFilePath || currentFilePath || '');
    const base = currentSeqInfo ? currentSeqInfo.prefix.replace(/[._-]+$/, '') || 'sequence' : baseName(src);
    return joinPath(dirName(src), base + suffix + ext);
  }

  async function ensureEditPresets() {
    if (!editPresets) editPresets = await window.electronAPI.editPresets();
    return editPresets;
  }

  /** describeSource() for the current media, cached per file. */
  async function ensureEditDesc() {
    const source = currentEditSource();
    if (!source) return null;
    const key = source.isImageSequence ? source.pattern : source.path;
    if (editDesc && editDescFor === key) return editDesc;
    const d = await window.electronAPI.editDescribe(source);
    if (d && d.error) { console.warn('[Edit] describe failed:', d.error); return null; }
    editDesc = d;
    editDescFor = key;
    return d;
  }

  function onMediaChanged(filePath) {
    inPoint = null;
    outPoint = null;
    playingSelection = false;
    editDesc = null;
    editDescFor = null;
    updateSelectionUI();
    loadMarkers(filePath);
    // A new picture means a new frame to draw through the LUT and new
    // geometry for the mask; both redraw once metadata lands.
  }

  // ─── In / Out selection ────────────────────────────────────────────────

  function setInPoint() {
    if (!hasVideoLoaded) return;
    inPoint = snapToFrame(video.currentTime);
    if (outPoint !== null && outPoint <= inPoint) outPoint = null;
    updateSelectionUI();
  }

  function setOutPoint() {
    if (!hasVideoLoaded) return;
    outPoint = snapToFrame(video.currentTime);
    if (inPoint !== null && inPoint >= outPoint) inPoint = null;
    updateSelectionUI();
  }

  function clearInOut() {
    inPoint = null;
    outPoint = null;
    playingSelection = false;
    updateSelectionUI();
  }

  function goToIn() { if (inPoint !== null) { stopShuttle(); seekTo(inPoint); } }
  function goToOut() { if (outPoint !== null) { stopShuttle(); seekTo(outPoint); } }

  /** The effective range: a missing In is the start, a missing Out the end. */
  function selectionRange() {
    const dur = mediaDuration();
    const a = inPoint !== null ? inPoint : 0;
    const b = outPoint !== null ? outPoint : dur;
    return { inTime: a, outTime: b, partial: inPoint === null || outPoint === null, length: Math.max(0, b - a) };
  }

  function hasSelection() { return inPoint !== null || outPoint !== null; }

  function updateSelectionUI() {
    const dur = mediaDuration();
    const show = hasSelection() && dur > 0;
    editBar.classList.toggle('hidden', !show);
    btnSetIn.classList.toggle('set', inPoint !== null);
    btnSetOut.classList.toggle('set', outPoint !== null);
    timelineIn.classList.toggle('hidden', inPoint === null || !dur);
    timelineOut.classList.toggle('hidden', outPoint === null || !dur);
    timelineRange.classList.toggle('hidden', !show);
    if (!show) return;

    const r = selectionRange();
    const pctIn = (r.inTime / dur) * 100;
    const pctOut = (r.outTime / dur) * 100;
    timelineIn.style.left = pctIn + '%';
    timelineOut.style.left = pctOut + '%';
    timelineRange.style.left = pctIn + '%';
    timelineRange.style.width = Math.max(0, pctOut - pctIn) + '%';

    editInEl.textContent = inPoint !== null ? tcOf(inPoint) : 'start';
    editOutEl.textContent = outPoint !== null ? tcOf(outPoint) : 'end';
    editDurEl.textContent = secondsToTimecode(r.length, frameRate) + ' (' + Math.round(r.length * frameRate) + ' fr)';
    describeLosslessness();
  }

  /** One line under the selection saying what a lossless cut will do here. */
  async function describeLosslessness() {
    editNoteEl.textContent = '';
    const d = await ensureEditDesc();
    if (!d || !hasSelection()) return;
    if (!d.losslessPossible) { editNoteEl.textContent = 'Image sequence — cuts are rendered to a movie'; return; }
    if (d.intraOnly) { editNoteEl.textContent = (d.video && d.video.codecFriendly ? d.video.codecFriendly : 'Intra-only') + ' — lossless cuts are frame accurate'; return; }
    editNoteEl.textContent = (d.video && d.video.codecFriendly ? d.video.codecFriendly : 'Long-GOP') + ' — lossless cuts snap to keyframes; choose an encode for frame accuracy';
  }

  function playSelection() {
    if (!hasVideoLoaded || !hasSelection()) return;
    const r = selectionRange();
    stopShuttle();
    seekTo(r.inTime);
    playingSelection = true;
    shuttleDirection = 1; shuttleSpeed = 1; video.playbackRate = 1;
    video.play().catch(() => {});
  }

  /** Called every animation frame while playing: stop or loop at Out. */
  function checkSelectionPlayback() {
    if (!playingSelection || outPoint === null) return;
    if (video.currentTime >= outPoint - frameDuration / 2) {
      if (loopEnabled) {
        seekTo(inPoint !== null ? inPoint : 0);
      } else {
        video.pause();
        seekTo(outPoint);
        playingSelection = false;
      }
    }
  }
  video.addEventListener('pause', () => { if (!video.seeking) playingSelection = false; });

  btnSetIn.addEventListener('click', setInPoint);
  btnSetOut.addEventListener('click', setOutPoint);
  document.getElementById('btn-play-sel').addEventListener('click', playSelection);
  document.getElementById('btn-trim-sel').addEventListener('click', () => openExportDialog({ range: 'selection', title: 'Trim to Selection' }));
  document.getElementById('btn-delete-sel').addEventListener('click', () => deleteSelection());
  document.getElementById('btn-copy-sel').addEventListener('click', () => copySelectionToBin());
  document.getElementById('btn-export-sel').addEventListener('click', () => openExportDialog({ range: 'selection' }));
  document.getElementById('btn-clear-sel').addEventListener('click', clearInOut);

  // ─── Markers ───────────────────────────────────────────────────────────
  //
  // A marker is a media time plus a name. They live per file (keyed by path)
  // in localStorage so they are still there when the file is reopened, and
  // can be exported as CSV / text / JSON for whoever needs the notes.

  const markersPanel = document.getElementById('markers-panel');
  const markersList = document.getElementById('markers-list');
  const markersEmpty = document.getElementById('markers-empty');
  const markersCount = document.getElementById('markers-count');

  let markers = [];        // [{ id, time, name }]
  let markersPath = null;

  function markersKey(p) { return 'maiden.markers:' + p; }

  function loadMarkers(filePath) {
    markersPath = filePath || null;
    markers = [];
    if (markersPath) {
      try {
        const raw = localStorage.getItem(markersKey(markersPath));
        if (raw) markers = JSON.parse(raw).filter((m) => typeof m.time === 'number');
      } catch (_) { markers = []; }
    }
    renderMarkers();
  }

  function saveMarkers() {
    if (!markersPath) return;
    try {
      if (markers.length) localStorage.setItem(markersKey(markersPath), JSON.stringify(markers));
      else localStorage.removeItem(markersKey(markersPath));
    } catch (err) { console.warn('[Markers] Could not persist:', err.message); }
  }

  function addMarker() {
    if (!hasVideoLoaded) return;
    const t = snapToFrame(video.currentTime);
    // One marker per frame: pressing M twice on the same frame is a no-op.
    if (markers.some((m) => Math.abs(m.time - t) < frameDuration / 2)) { flashMarkerButton(); return; }
    markers.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: t, name: '' });
    markers.sort((a, b) => a.time - b.time);
    saveMarkers();
    renderMarkers();
    flashMarkerButton();
  }

  function flashMarkerButton() {
    btnAddMarker.classList.add('active');
    setTimeout(() => btnAddMarker.classList.remove('active'), 220);
  }

  function deleteMarker(id) {
    markers = markers.filter((m) => m.id !== id);
    saveMarkers();
    renderMarkers();
  }

  function deleteMarkerAtPlayhead() {
    const t = video.currentTime;
    const hit = markers.find((m) => Math.abs(m.time - t) < frameDuration * 0.75);
    if (hit) deleteMarker(hit.id);
  }

  function clearMarkers() {
    if (!markers.length) return;
    if (!confirm('Remove all ' + markers.length + ' markers for this movie?')) return;
    markers = [];
    saveMarkers();
    renderMarkers();
  }

  function nextMarker() {
    const t = video.currentTime + frameDuration / 2;
    const m = markers.find((k) => k.time > t);
    if (m) { stopShuttle(); seekTo(m.time); }
  }

  function prevMarker() {
    const t = video.currentTime - frameDuration / 2;
    const before = markers.filter((k) => k.time < t);
    if (before.length) { stopShuttle(); seekTo(before[before.length - 1].time); }
  }

  function renderMarkers() {
    renderTimelineMarkers();
    renderMarkersPanel();
  }

  function renderTimelineMarkers() {
    timelineMarkers.innerHTML = '';
    const dur = mediaDuration();
    if (!dur) return;
    for (const m of markers) {
      const tick = document.createElement('div');
      tick.className = 'timeline-marker';
      tick.style.left = (m.time / dur) * 100 + '%';
      tick.title = tcOf(m.time) + (m.name ? ' — ' + m.name : '');
      tick.addEventListener('click', (e) => { e.stopPropagation(); stopShuttle(); seekTo(m.time); });
      tick.addEventListener('mousedown', (e) => e.stopPropagation());   // not a scrub
      timelineMarkers.appendChild(tick);
    }
  }

  function renderMarkersPanel() {
    markersList.innerHTML = '';
    markersCount.textContent = markers.length ? '(' + markers.length + ')' : '';
    markersEmpty.classList.toggle('hidden', markers.length > 0);
    markers.forEach((m) => {
      const row = document.createElement('div');
      row.className = 'marker-row';
      row.dataset.id = m.id;

      const tc = document.createElement('button');
      tc.className = 'marker-tc';
      tc.textContent = tcOf(m.time);
      tc.title = 'Go to marker';
      tc.addEventListener('click', () => { stopShuttle(); seekTo(m.time); });

      const name = document.createElement('input');
      name.className = 'marker-name';
      name.type = 'text';
      name.placeholder = 'Note…';
      name.value = m.name || '';
      name.addEventListener('change', () => { m.name = name.value.trim(); saveMarkers(); renderTimelineMarkers(); });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') name.blur(); e.stopPropagation(); });

      const del = document.createElement('button');
      del.className = 'marker-del';
      del.textContent = '×';
      del.title = 'Delete marker';
      del.addEventListener('click', () => deleteMarker(m.id));

      row.appendChild(tc); row.appendChild(name); row.appendChild(del);
      markersList.appendChild(row);
    });
    renderMarkersPanelActive();
  }

  /** Highlight the marker under the playhead in the panel. */
  function renderMarkersPanelActive() {
    if (markersPanel.classList.contains('hidden')) return;
    const t = video.currentTime;
    for (const row of markersList.children) {
      const m = markers.find((k) => k.id === row.dataset.id);
      row.classList.toggle('active', !!m && Math.abs(m.time - t) < frameDuration * 0.75);
    }
  }

  async function exportMarkers() {
    if (!markers.length) { alert('There are no markers to export.'); return; }
    const out = await window.electronAPI.showSaveDialog({
      title: 'Export Markers',
      defaultPath: defaultOutput('_markers', '.csv'),
      filters: [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'Text', extensions: ['txt'] },
        { name: 'JSON', extensions: ['json'] },
      ],
    });
    if (!out) return;
    const ext = out.split('.').pop().toLowerCase();
    let text;
    if (ext === 'json') {
      text = JSON.stringify({
        file: markersPath, frameRate, sourceTimecodeStart: sourceTimecodeStr || null,
        markers: markers.map((m, i) => ({ index: i + 1, timecode: tcOf(m.time), frame: Math.round(m.time * frameRate), seconds: +m.time.toFixed(4), name: m.name || '' })),
      }, null, 2);
    } else if (ext === 'txt') {
      text = markers.map((m, i) => String(i + 1).padStart(3, ' ') + '  ' + tcOf(m.time) + '  ' + (m.name || '')).join('\n') + '\n';
    } else {
      const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
      text = 'Marker,Timecode,Frame,Seconds,Name\n' +
        markers.map((m, i) => [i + 1, tcOf(m.time), Math.round(m.time * frameRate), m.time.toFixed(4), q(m.name || '')].join(',')).join('\n') + '\n';
    }
    const r = await window.electronAPI.saveTextFile(out, text);
    if (r && r.error) alert('Could not write the markers file:\n\n' + r.error);
    else showJobDone('Exported ' + markers.length + ' markers', out, false);
  }

  btnAddMarker.addEventListener('click', addMarker);
  document.getElementById('btn-close-markers').addEventListener('click', () => markersPanel.classList.add('hidden'));
  document.getElementById('btn-export-markers').addEventListener('click', exportMarkers);
  document.getElementById('btn-clear-markers').addEventListener('click', clearMarkers);
  video.addEventListener('timeupdate', renderMarkersPanelActive);

  // ─── Background jobs (one at a time) ───────────────────────────────────

  const jobToast = document.getElementById('job-toast');
  const jobLabel = document.getElementById('job-label');
  const jobPct = document.getElementById('job-pct');
  const jobBar = document.getElementById('job-bar');
  const jobCancelBtn = document.getElementById('job-cancel');
  const jobRevealBtn = document.getElementById('job-reveal');
  const jobOpenBtn = document.getElementById('job-open');
  const jobCloseBtn = document.getElementById('job-close');

  let activeJob = null;     // { id, output }
  let jobHideTimer = null;

  function showJobRunning(label) {
    clearTimeout(jobHideTimer);
    jobToast.classList.remove('hidden', 'done', 'failed');
    jobLabel.textContent = label;
    jobPct.textContent = '0%';
    jobBar.style.width = '0%';
    jobCancelBtn.classList.remove('hidden');
    jobRevealBtn.classList.add('hidden');
    jobOpenBtn.classList.add('hidden');
    jobCloseBtn.classList.add('hidden');
  }

  function showJobDone(label, output, openable) {
    clearTimeout(jobHideTimer);
    jobToast.classList.remove('hidden', 'failed');
    jobToast.classList.add('done');
    jobLabel.textContent = label;
    jobLabel.title = output || '';
    jobPct.textContent = '';
    jobBar.style.width = '100%';
    jobCancelBtn.classList.add('hidden');
    jobRevealBtn.classList.toggle('hidden', !output);
    jobRevealBtn.onclick = () => window.electronAPI.revealInFolder(output);
    jobOpenBtn.classList.toggle('hidden', !(output && openable));
    jobOpenBtn.onclick = () => { jobToast.classList.add('hidden'); openFile(output); };
    jobCloseBtn.classList.remove('hidden');
    jobHideTimer = setTimeout(() => jobToast.classList.add('hidden'), 15000);
  }

  function showJobFailed(message) {
    clearTimeout(jobHideTimer);
    jobToast.classList.remove('hidden', 'done');
    jobToast.classList.add('failed');
    jobLabel.textContent = message;
    jobPct.textContent = '';
    jobBar.style.width = '0%';
    jobCancelBtn.classList.add('hidden');
    jobRevealBtn.classList.add('hidden');
    jobOpenBtn.classList.add('hidden');
    jobCloseBtn.classList.remove('hidden');
  }

  jobCloseBtn.addEventListener('click', () => jobToast.classList.add('hidden'));
  jobCancelBtn.addEventListener('click', () => { if (activeJob) window.electronAPI.editCancel(activeJob.id); });
  window.electronAPI.onEditProgress((info) => {
    if (!activeJob || !info || info.jobId !== activeJob.id) return;
    const pct = Math.round((info.pct || 0) * 100);
    jobPct.textContent = pct + '%';
    jobBar.style.width = pct + '%';
  });

  /**
   * Run one editor operation with progress in the toast. Resolves to the
   * result, or null when it failed or was cancelled (already reported).
   */
  async function runEditJob(op, payload, label, opts) {
    opts = opts || {};
    if (activeJob) { alert('Another operation is still running. Wait for it to finish or cancel it first.'); return null; }
    const id = 'job' + Date.now().toString(36);
    activeJob = { id, output: payload.output };
    showJobRunning(label);
    let result;
    try {
      result = await window.electronAPI.editRun(op, Object.assign({}, payload, { jobId: id }));
    } catch (err) {
      result = { error: err.message };
    }
    activeJob = null;
    if (!result || result.cancelled) { jobToast.classList.add('hidden'); return null; }
    if (result.error) {
      console.error('[Edit] ' + op + ' failed:', result.error);
      showJobFailed(result.error.split('\n')[0]);
      alert(label + ' failed.\n\n' + result.error);
      return null;
    }
    const name = (payload.output || '').split(/[\\/]/).pop();
    let done = 'Saved ' + name;
    // trim / deleteRange report where a lossless cut actually landed. (combine
    // returns an array of snaps instead; its entries are listed in the panel.)
    const snap = result.snapped;
    if (snap && !Array.isArray(snap) && !snap.exact && !snap.unknown && typeof result.inTime === 'number') {
      done += ' (snapped to keyframes: ' + tcOf(result.inTime) + ' → ' + tcOf(result.outTime) + ')';
    }
    showJobDone(done, payload.output, opts.openable !== false);
    return result;
  }

  // ─── Save Current Frame ────────────────────────────────────────────────

  async function saveCurrentFrame() {
    const source = currentEditSource();
    if (!source) return;
    const presets = await ensureEditPresets();
    const t = video.currentTime;
    const filters = presets.stills.map((s) => ({ name: s.label, extensions: [s.ext.slice(1)].concat(s.key === 'jpg' ? ['jpeg'] : s.key === 'tiff' ? ['tiff'] : []) }));
    const out = await window.electronAPI.showSaveDialog({
      title: 'Save Current Frame',
      defaultPath: defaultOutput('_' + tcForName(t), '.png'),
      filters,
    });
    if (!out) return;
    const ext = out.split('.').pop().toLowerCase();
    const format = ({ png: 'png', jpg: 'jpg', jpeg: 'jpg', tif: 'tiff', tiff: 'tiff', dpx: 'dpx', exr: 'exr' })[ext] || 'png';
    // The saved frame matches what is on screen: if the LUT is on, it is baked in.
    await runEditJob('saveFrame', { source, time: t, output: out, format, lut: lutActive() ? lookState.lutPath : null },
      'Saving frame ' + tcOf(t) + '…', { openable: false });
  }
  btnSaveFrame.addEventListener('click', saveCurrentFrame);

  // ─── Export / Trim / Delete dialog ─────────────────────────────────────

  const exportDialog = document.getElementById('export-dialog');
  const exportTitle = document.getElementById('export-title');
  const exportSubtitle = document.getElementById('export-subtitle');
  const exportRangeSel = document.getElementById('export-range');
  const exportFormatSel = document.getElementById('export-format');
  const exportLutRow = document.getElementById('export-lut-row');
  const exportBakeLut = document.getElementById('export-bake-lut');
  const exportNote = document.getElementById('export-note');
  let exportMode = 'export';      // 'export' | 'delete'

  function populateFormatSelect(sel, desc, allowCopy) {
    sel.innerHTML = '';
    if (allowCopy) {
      const o = document.createElement('option');
      o.value = 'copy';
      o.textContent = 'Lossless — no re-encode' + (desc && !desc.intraOnly ? ' (cuts snap to keyframes)' : ' (frame accurate)');
      sel.appendChild(o);
    }
    for (const p of (editPresets ? editPresets.encode : [])) {
      const o = document.createElement('option');
      o.value = p.key;
      o.textContent = p.label;
      sel.appendChild(o);
    }
  }

  async function openExportDialog(opts) {
    opts = opts || {};
    const source = currentEditSource();
    if (!source) return;
    await ensureEditPresets();
    const desc = await ensureEditDesc();
    exportMode = opts.mode || 'export';

    const forceSelection = opts.range === 'selection' || exportMode === 'delete';
    if (forceSelection && !hasSelection()) { alert('Set an In and/or Out point first (I and O).'); return; }

    exportTitle.textContent = opts.title || (exportMode === 'delete' ? 'Delete Selection' : 'Export');
    exportSubtitle.textContent = exportMode === 'delete'
      ? 'Removes In → Out and saves everything else as a new movie.'
      : 'Save a new file from the current movie. The source is never modified.';
    exportRangeSel.value = (opts.range === 'selection' || (opts.range === 'auto' && hasSelection())) ? 'selection' : 'all';
    exportRangeSel.disabled = forceSelection;
    exportRangeSel.querySelector('option[value="selection"]').disabled = !hasSelection();

    populateFormatSelect(exportFormatSel, desc, !!(desc && desc.losslessPossible));
    exportFormatSel.value = desc && desc.losslessPossible ? 'copy' : 'prores_422hq';
    exportBakeLut.checked = false;
    updateExportNote();
    exportDialog.classList.remove('hidden');
  }

  async function updateExportNote() {
    const desc = editDesc;
    const fmt = exportFormatSel.value;
    exportLutRow.classList.toggle('hidden', !(lookState.lutPath && fmt !== 'copy'));
    exportNote.className = 'dialog-note';
    if (!desc) { exportNote.textContent = ''; return; }

    if (fmt !== 'copy') {
      exportNote.textContent = 'Re-encodes the picture (frame accurate). Audio is carried over as 24-bit PCM, or AAC in MP4.';
      return;
    }
    if (desc.intraOnly) {
      exportNote.textContent = 'Stream copy — no quality loss, finishes at disk speed, frame accurate on ' + (desc.video.codecFriendly || 'this codec') + '.';
      exportNote.classList.add('ok');
      return;
    }
    const useSel = exportRangeSel.value === 'selection' || exportMode === 'delete';
    if (!useSel) {
      exportNote.textContent = 'Stream copy of the whole movie — a remux, no quality loss.';
      exportNote.classList.add('ok');
      return;
    }
    const r = selectionRange();
    exportNote.textContent = 'Checking keyframes…';
    const snap = await window.electronAPI.editSnap(currentEditSource(), inPoint !== null ? r.inTime : undefined, outPoint !== null ? r.outTime : undefined);
    if (!snap || snap.error || snap.unknown) {
      exportNote.textContent = 'Long-GOP source: a lossless cut lands on the nearest keyframes. Choose an encode for a frame-accurate cut.';
      exportNote.classList.add('warn');
      return;
    }
    if (snap.exact) {
      exportNote.textContent = 'Both points fall on keyframes — this lossless cut is frame accurate.';
      exportNote.classList.add('ok');
    } else {
      const parts = [];
      if (inPoint !== null) parts.push('In ' + tcOf(snap.inTime) + ' (' + (snap.inDeltaFrames > 0 ? '+' : '') + snap.inDeltaFrames + ' fr)');
      if (outPoint !== null) parts.push('Out ' + tcOf(snap.outTime) + ' (' + (snap.outDeltaFrames > 0 ? '+' : '') + snap.outDeltaFrames + ' fr)');
      exportNote.textContent = 'Lossless cut will snap to keyframes: ' + parts.join(', ') + '. Choose an encode for a frame-accurate cut.';
      exportNote.classList.add('warn');
    }
  }
  exportFormatSel.addEventListener('change', updateExportNote);
  exportRangeSel.addEventListener('change', updateExportNote);
  document.getElementById('export-btn-cancel').addEventListener('click', () => exportDialog.classList.add('hidden'));

  document.getElementById('export-btn-save').addEventListener('click', async () => {
    const source = currentEditSource();
    if (!source) return;
    const fmt = exportFormatSel.value;
    const useSel = exportRangeSel.value === 'selection' || exportMode === 'delete';
    const r = selectionRange();
    const preset = fmt === 'copy' ? null : editPresets.encode.find((p) => p.key === fmt);

    // Default container: the source's own for a stream copy (MXF → MOV, the
    // safer target), the preset's for an encode.
    const srcExt = (editDesc && editDesc.ext) || '.mov';
    let ext = preset ? preset.ext : (['.mov', '.mp4', '.m4v', '.mkv'].includes(srcExt) ? srcExt : '.mov');
    const containerFilters = [
      { name: 'QuickTime Movie', extensions: ['mov'] },
      { name: 'MP4', extensions: ['mp4'] },
      { name: 'MXF', extensions: ['mxf'] },
      { name: 'Matroska', extensions: ['mkv'] },
    ];
    containerFilters.sort((a, b) => ('.' + a.extensions[0] === ext ? -1 : 0) - ('.' + b.extensions[0] === ext ? -1 : 0));

    let suffix;
    if (exportMode === 'delete') suffix = '_cut';
    else if (useSel) suffix = '_' + tcForName(r.inTime) + '-' + tcForName(r.outTime);
    else suffix = preset ? '_' + fmt : '_copy';

    const out = await window.electronAPI.showSaveDialog({
      title: exportTitle.textContent,
      defaultPath: defaultOutput(suffix, ext),
      filters: containerFilters,
    });
    if (!out) return;
    exportDialog.classList.add('hidden');

    const payload = {
      source,
      output: out,
      mode: fmt === 'copy' ? 'copy' : 'encode',
      preset: preset ? preset.key : undefined,
      lut: (exportBakeLut.checked && fmt !== 'copy' && lookState.lutPath) ? lookState.lutPath : null,
    };
    if (exportMode === 'delete') {
      payload.inTime = r.inTime; payload.outTime = r.outTime;
      await runEditJob('deleteRange', payload, 'Deleting ' + tcOf(r.inTime) + ' → ' + tcOf(r.outTime) + '…');
    } else {
      if (useSel) { payload.inTime = r.inTime; payload.outTime = outPoint !== null ? r.outTime : undefined; }
      await runEditJob('trim', payload, (useSel ? 'Trimming' : 'Exporting') + ' to ' + out.split(/[\\/]/).pop() + '…');
    }
  });

  function deleteSelection() {
    if (!hasSelection()) { alert('Set an In and/or Out point first (I and O).'); return; }
    openExportDialog({ mode: 'delete', range: 'selection' });
  }

  // ─── Clip bin / Combine Movies ─────────────────────────────────────────

  const combinePanel = document.getElementById('combine-panel');
  const combineList = document.getElementById('combine-list');
  const combineStatus = document.getElementById('combine-status');
  const combineFormatSel = document.getElementById('combine-format');
  let combineEntries = [];       // [{ source, inTime?, outTime?, label, rangeLabel }]
  let combineCheck = null;
  let combineCheckTimer = null;

  function entryLabel(source) {
    return source.isImageSequence ? source.pattern.split(/[\\/]/).pop() : source.path.split(/[\\/]/).pop();
  }

  function addCombineEntry(entry) {
    combineEntries.push(entry);
    renderCombine();
    scheduleCombineCheck();
  }

  function copySelectionToBin() {
    const source = currentEditSource();
    if (!source) return;
    const r = selectionRange();
    const entry = { source, label: entryLabel(source) };
    if (hasSelection()) {
      entry.inTime = r.inTime;
      entry.outTime = outPoint !== null ? r.outTime : undefined;
      entry.rangeLabel = tcOf(r.inTime) + ' → ' + tcOf(r.outTime);
    } else {
      entry.rangeLabel = 'whole movie';
    }
    addCombineEntry(entry);
    togglePanel(combinePanel);
    if (combinePanel.classList.contains('hidden')) combinePanel.classList.remove('hidden');
  }

  function addCurrentToCombine() {
    const source = currentEditSource();
    if (!source) return;
    addCombineEntry({ source, label: entryLabel(source), rangeLabel: 'whole movie' });
  }

  async function addFilesToCombine(paths) {
    if (!paths) {
      paths = await window.electronAPI.showOpenDialog({
        title: 'Add Movies to Combine',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Movies', extensions: ['mov', 'mp4', 'm4v', 'mxf', 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'webm'] }, { name: 'All Files', extensions: ['*'] }],
      });
    }
    for (const p of paths || []) addCombineEntry({ source: { path: p }, label: p.split(/[\\/]/).pop(), rangeLabel: 'whole movie' });
  }

  function renderCombine() {
    combineList.innerHTML = '';
    combineEntries.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'combine-row';
      const idx = document.createElement('span');
      idx.className = 'combine-index';
      idx.textContent = String(i + 1);
      const name = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'combine-name';
      title.textContent = e.label;
      title.title = e.source.path || e.source.pattern;
      const meta = document.createElement('div');
      meta.className = 'combine-meta';
      meta.textContent = e.rangeLabel || '';
      name.appendChild(title); name.appendChild(meta);
      const ctrls = document.createElement('div');
      ctrls.className = 'combine-ctrls';
      const up = document.createElement('button'); up.className = 'combine-btn'; up.textContent = '↑'; up.title = 'Move up'; up.disabled = i === 0;
      const down = document.createElement('button'); down.className = 'combine-btn'; down.textContent = '↓'; down.title = 'Move down'; down.disabled = i === combineEntries.length - 1;
      const del = document.createElement('button'); del.className = 'combine-btn'; del.textContent = '×'; del.title = 'Remove';
      up.addEventListener('click', () => { [combineEntries[i - 1], combineEntries[i]] = [combineEntries[i], combineEntries[i - 1]]; renderCombine(); scheduleCombineCheck(); });
      down.addEventListener('click', () => { [combineEntries[i + 1], combineEntries[i]] = [combineEntries[i], combineEntries[i + 1]]; renderCombine(); scheduleCombineCheck(); });
      del.addEventListener('click', () => { combineEntries.splice(i, 1); renderCombine(); scheduleCombineCheck(); });
      ctrls.appendChild(up); ctrls.appendChild(down); ctrls.appendChild(del);
      row.appendChild(idx); row.appendChild(name); row.appendChild(ctrls);
      combineList.appendChild(row);
    });
    document.getElementById('btn-combine-save').disabled = combineEntries.length < 1;
    if (!combineEntries.length) { combineStatus.textContent = 'Add two or more movies, or send selections here with ⌘B.'; combineStatus.className = 'dialog-note'; }
  }

  function scheduleCombineCheck() {
    clearTimeout(combineCheckTimer);
    combineCheck = null;
    if (combineEntries.length < 1) return;
    combineStatus.textContent = 'Checking compatibility…';
    combineStatus.className = 'dialog-note';
    combineCheckTimer = setTimeout(runCombineCheck, 250);
  }

  async function runCombineCheck() {
    await ensureEditPresets();
    const entries = combineEntries.map((e) => ({ source: e.source, inTime: e.inTime, outTime: e.outTime }));
    const check = await window.electronAPI.editCheckCombine(entries);
    if (!check || check.error) {
      combineStatus.textContent = 'Could not read one of the movies: ' + (check && check.error);
      combineStatus.className = 'dialog-note error';
      return;
    }
    combineCheck = check;
    populateFormatSelect(combineFormatSel, { intraOnly: check.intraOnly }, check.lossless);
    combineFormatSel.value = check.lossless ? 'copy' : 'prores_422hq';
    if (check.lossless) {
      combineStatus.textContent = 'All movies match — they can be joined losslessly, no re-encode.' +
        (check.notes && check.notes.length ? ' ' + check.notes.join('; ') + '.' : '');
      combineStatus.className = 'dialog-note ok';
    } else {
      combineStatus.textContent = 'A lossless join is not possible: ' + check.reasons.slice(0, 4).join('; ') +
        (check.reasons.length > 4 ? '; …' : '') + '. Everything will be conformed to the first movie and re-encoded.';
      combineStatus.className = 'dialog-note warn';
    }
  }

  async function saveCombined() {
    if (!combineEntries.length) return;
    await ensureEditPresets();
    const fmt = combineFormatSel.value || 'prores_422hq';
    const preset = fmt === 'copy' ? null : editPresets.encode.find((p) => p.key === fmt);
    const first = combineEntries[0].source;
    const firstPath = first.path || first.pattern;
    const srcExt = '.' + (firstPath.split('.').pop() || 'mov').toLowerCase();
    const ext = preset ? preset.ext : (['.mov', '.mp4', '.m4v', '.mkv'].includes(srcExt) ? srcExt : '.mov');
    const out = await window.electronAPI.showSaveDialog({
      title: 'Save Combined Movie',
      defaultPath: joinPath(dirName(firstPath), baseName(firstPath) + '_combined' + ext),
      filters: [{ name: 'QuickTime Movie', extensions: ['mov'] }, { name: 'MP4', extensions: ['mp4'] }, { name: 'MXF', extensions: ['mxf'] }, { name: 'Matroska', extensions: ['mkv'] }]
        .sort((a, b) => ('.' + a.extensions[0] === ext ? -1 : 0) - ('.' + b.extensions[0] === ext ? -1 : 0)),
    });
    if (!out) return;
    const entries = combineEntries.map((e) => ({ source: e.source, inTime: e.inTime, outTime: e.outTime }));
    const result = await runEditJob('combine', {
      entries, output: out, mode: fmt === 'copy' ? 'copy' : 'encode', preset: preset ? preset.key : undefined,
    }, 'Combining ' + entries.length + ' movie' + (entries.length === 1 ? '' : 's') + '…');
    if (result) console.log('[Edit] Combined as', result.mode);
  }

  /** Append Movie: pick a file, join it after the current movie, save. */
  async function appendMovie() {
    const source = currentEditSource();
    if (!source) return;
    const picked = await window.electronAPI.showOpenDialog({
      title: 'Append Movie — choose the movie to add after the current one',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Movies', extensions: ['mov', 'mp4', 'm4v', 'mxf', 'mkv', 'avi', 'mts', 'm2ts', 'ts', 'webm'] }, { name: 'All Files', extensions: ['*'] }],
    });
    if (!picked || !picked.length) return;
    combineEntries = [{ source, label: entryLabel(source), rangeLabel: 'whole movie' }]
      .concat(picked.map((p) => ({ source: { path: p }, label: p.split(/[\\/]/).pop(), rangeLabel: 'whole movie' })));
    renderCombine();
    togglePanel(combinePanel);
    if (combinePanel.classList.contains('hidden')) combinePanel.classList.remove('hidden');
    await runCombineCheck();
  }

  document.getElementById('btn-close-combine').addEventListener('click', () => combinePanel.classList.add('hidden'));
  document.getElementById('btn-combine-add-current').addEventListener('click', addCurrentToCombine);
  document.getElementById('btn-combine-add-files').addEventListener('click', () => addFilesToCombine());
  document.getElementById('btn-combine-clear').addEventListener('click', () => { combineEntries = []; renderCombine(); scheduleCombineCheck(); });
  document.getElementById('btn-combine-save').addEventListener('click', saveCombined);
  // Files dropped on the panel join the list instead of replacing the movie.
  combinePanel.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); combinePanel.classList.add('drop-target'); });
  combinePanel.addEventListener('dragleave', () => combinePanel.classList.remove('drop-target'));
  combinePanel.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    combinePanel.classList.remove('drop-target');
    dragCounter = 0;
    dragOverlay.classList.remove('visible');
    addFilesToCombine(Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean));
  });
  renderCombine();

  // ─── Audio operations ──────────────────────────────────────────────────

  const muteDialog = document.getElementById('mute-dialog');
  const muteTracks = document.getElementById('mute-tracks');

  async function audioOp(payload) {
    const source = currentEditSource();
    if (!source) return;
    if (source.isImageSequence) { alert('An image sequence has no audio to work with.'); return; }
    const desc = await ensureEditDesc();
    const op = payload.op;

    if (op === 'extract') {
      if (!desc || !desc.audio.length) { alert('This movie has no audio.'); return; }
      const fmt = payload.format;
      const ext = fmt === 'wav' ? '.wav' : fmt === 'aiff' ? '.aif' : '.mov';
      const out = await window.electronAPI.showSaveDialog({
        title: 'Extract Audio',
        defaultPath: defaultOutput('_audio', ext),
        filters: fmt === 'wav' ? [{ name: 'WAV', extensions: ['wav'] }] : fmt === 'aiff' ? [{ name: 'AIFF', extensions: ['aif', 'aiff'] }] : [{ name: 'QuickTime Movie (audio only)', extensions: ['mov'] }],
      });
      if (!out) return;
      await runEditJob('extractAudio', { source, output: out, format: fmt }, 'Extracting audio…', { openable: false });
      return;
    }

    if (op === 'remove') {
      const out = await window.electronAPI.showSaveDialog({
        title: 'Remove Audio — save picture only',
        defaultPath: defaultOutput('_noaudio', desc && desc.ext === '.mp4' ? '.mp4' : '.mov'),
        filters: [{ name: 'QuickTime Movie', extensions: ['mov'] }, { name: 'MP4', extensions: ['mp4'] }, { name: 'MXF', extensions: ['mxf'] }],
      });
      if (!out) return;
      await runEditJob('removeAudio', { source, output: out }, 'Removing audio…');
      return;
    }

    if (op === 'replace' || op === 'add') {
      const picked = await window.electronAPI.showOpenDialog({
        title: op === 'replace' ? 'Replace Audio — choose the new audio' : 'Add Audio Track — choose the audio to add',
        properties: ['openFile'],
        filters: [{ name: 'Audio', extensions: ['wav', 'aif', 'aiff', 'mp3', 'aac', 'm4a', 'flac', 'ac3', 'mov', 'mp4', 'mxf'] }, { name: 'All Files', extensions: ['*'] }],
      });
      if (!picked || !picked.length) return;
      const out = await window.electronAPI.showSaveDialog({
        title: op === 'replace' ? 'Replace Audio — save as' : 'Add Audio Track — save as',
        defaultPath: defaultOutput(op === 'replace' ? '_newaudio' : '_addaudio', desc && desc.ext === '.mp4' ? '.mp4' : '.mov'),
        filters: [{ name: 'QuickTime Movie', extensions: ['mov'] }, { name: 'MP4', extensions: ['mp4'] }, { name: 'MXF', extensions: ['mxf'] }],
      });
      if (!out) return;
      await runEditJob('replaceAudio', { source, audioPath: picked[0], output: out, add: op === 'add' },
        (op === 'replace' ? 'Replacing' : 'Adding') + ' audio…');
      return;
    }

    if (op === 'mute') openMuteDialog(desc);
  }

  function openMuteDialog(desc) {
    if (!desc || !desc.audio.length) { alert('This movie has no audio.'); return; }
    muteTracks.innerHTML = '';
    desc.audio.forEach((a, t) => {
      const wrap = document.createElement('div');
      wrap.className = 'mute-track';
      const title = document.createElement('div');
      title.className = 'mute-track-title';
      const label = document.createElement('span');
      label.textContent = 'Track ' + (t + 1) + ' — ' + (a.codecFriendly || a.codec) + ', ' + a.channels + ' ch' + (a.channelLayout ? ' (' + a.channelLayout + ')' : '');
      const all = document.createElement('button');
      all.textContent = 'mute all';
      title.appendChild(label); title.appendChild(all);
      const chans = document.createElement('div');
      chans.className = 'mute-channels';
      const boxes = [];
      for (let c = 0; c < (a.channels || 0); c++) {
        const l = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.dataset.track = String(t);
        cb.dataset.channel = String(c);
        cb.addEventListener('change', () => l.classList.toggle('on', cb.checked));
        l.appendChild(cb);
        l.appendChild(document.createTextNode((a.speakerLabels && a.speakerLabels[c]) || ('Ch ' + (c + 1))));
        chans.appendChild(l);
        boxes.push(cb);
      }
      all.addEventListener('click', () => {
        const on = !boxes.every((b) => b.checked);
        boxes.forEach((b) => { b.checked = on; b.dispatchEvent(new Event('change')); });
      });
      wrap.appendChild(title); wrap.appendChild(chans);
      muteTracks.appendChild(wrap);
    });
    muteDialog.classList.remove('hidden');
  }

  document.getElementById('mute-btn-cancel').addEventListener('click', () => muteDialog.classList.add('hidden'));
  document.getElementById('mute-btn-save').addEventListener('click', async () => {
    const source = currentEditSource();
    if (!source) return;
    const byTrack = new Map();
    muteTracks.querySelectorAll('input[type="checkbox"]:checked').forEach((cb) => {
      const t = parseInt(cb.dataset.track, 10);
      if (!byTrack.has(t)) byTrack.set(t, []);
      byTrack.get(t).push(parseInt(cb.dataset.channel, 10));
    });
    if (!byTrack.size) { alert('Tick at least one channel to mute.'); return; }
    const out = await window.electronAPI.showSaveDialog({
      title: 'Mute Channels — save as',
      defaultPath: defaultOutput('_muted', editDesc && editDesc.ext === '.mp4' ? '.mp4' : '.mov'),
      filters: [{ name: 'QuickTime Movie', extensions: ['mov'] }, { name: 'MP4', extensions: ['mp4'] }, { name: 'MXF', extensions: ['mxf'] }],
    });
    if (!out) return;
    muteDialog.classList.add('hidden');
    const mutes = Array.from(byTrack.entries()).map(([track, channels]) => ({ track, channels }));
    await runEditJob('muteChannels', { source, mutes, output: out }, 'Muting channels…');
  });

  // ─── Look & framing: LUT preview and aspect-ratio masks ────────────────
  //
  // State is owned by the main process (View menu, persistence); this side
  // renders it. Any control here calls lookUpdate() and waits for the state
  // to come back rather than mutating a local copy, so the menu, the panel
  // and the keyboard can never disagree.

  const lutCanvas = document.getElementById('lut-canvas');
  const maskCanvas = document.getElementById('mask-canvas');
  const lutBadge = document.getElementById('lut-badge');
  const lookPanel = document.getElementById('look-panel');
  const lookLutName = document.getElementById('look-lut-name');
  const lookLutEnabled = document.getElementById('look-lut-enabled');
  const lookLutSdi = document.getElementById('look-lut-sdi');
  const lookLutNote = document.getElementById('look-lut-note');
  const maskPresetsEl = document.getElementById('mask-presets');
  const maskCustomInput = document.getElementById('mask-custom');
  const maskOpacityInput = document.getElementById('mask-opacity');
  const maskOpacityValue = document.getElementById('mask-opacity-value');
  const guideCrosshair = document.getElementById('guide-crosshair');
  const guideAction = document.getElementById('guide-action');
  const guideTitle = document.getElementById('guide-title');

  // Mirrors MASK_PRESETS in main.js (keys must match).
  const MASK_PRESETS = [
    { key: '1.43', label: '1.43', ratio: 1.43 },
    { key: '1.78', label: '1.78', ratio: 16 / 9 },
    { key: '1.85', label: '1.85', ratio: 1.85 },
    { key: '2.39', label: '2.39', ratio: 2.39 },
    { key: '2.40', label: '2.40', ratio: 2.40 },
    { key: '9:16', label: '9:16', ratio: 9 / 16 },
    { key: '4:5', label: '4:5', ratio: 4 / 5 },
  ];

  let lookState = { lutPath: null, lutEnabled: false, lutToSdi: true, maskPreset: null, maskCustomRatio: 2, maskOpacity: 0.7, crosshair: false, actionSafe: false, titleSafe: false };
  const masks = window.MaidenMasks.create(maskCanvas, video);
  let lutRenderer = null;        // created on first use (needs WebGL2)
  let lutLoadedPath = null;      // the .cube currently in the GPU
  let lutLoadedInfo = null;      // parsed header for the panel
  let lutDrawScheduled = false;
  let lastSdiLut = null;         // what the SDI output was last started with

  function lutActive() {
    return !!(lookState.lutEnabled && lookState.lutPath && lutRenderer && lutLoadedPath === lookState.lutPath);
  }

  function ensureLutRenderer() {
    if (lutRenderer) return lutRenderer;
    try {
      lutRenderer = window.MaidenLUT.createRenderer(lutCanvas);
    } catch (err) {
      console.error('[LUT] renderer failed:', err.message);
      lutRenderer = null;
    }
    if (!lutRenderer) alert('LUT preview needs WebGL2, which is not available on this GPU. LUTs will still apply to SDI output, exports and saved frames.');
    return lutRenderer;
  }

  async function loadLutIntoGpu(lutPath) {
    if (!lutPath) { lutLoadedPath = null; lutLoadedInfo = null; if (lutRenderer) lutRenderer.setLUT(null); return; }
    if (lutLoadedPath === lutPath) return;
    const r = await window.electronAPI.readTextFile(lutPath);
    if (r.error) { alert('Could not read the LUT:\n\n' + r.error); window.electronAPI.lookUpdate({ lutPath: null, lutEnabled: false }); return; }
    let lut;
    try { lut = window.MaidenLUT.parseCube(r.text); } catch (err) {
      alert('Could not load the LUT:\n\n' + err.message);
      window.electronAPI.lookUpdate({ lutPath: null, lutEnabled: false });
      return;
    }
    if (!ensureLutRenderer()) { lutLoadedInfo = lut; lutLoadedPath = lutPath; return; }
    try { lutRenderer.setLUT(lut); } catch (err) {
      alert('The GPU rejected this LUT:\n\n' + err.message);
      window.electronAPI.lookUpdate({ lutPath: null, lutEnabled: false });
      return;
    }
    lutLoadedPath = lutPath;
    lutLoadedInfo = lut;
    console.log('[LUT] Loaded', lutPath, lut.is3D ? lut.size + '³' : '1D ' + lut.size, lutRenderer.precision);
  }

  /** Draw the current video frame through the LUT (no-op when the LUT is off). */
  function drawLutFrame() {
    if (!lutActive()) return;
    lutRenderer.draw(video);
  }

  // While the LUT is on, every presented video frame is redrawn through it.
  function lutFrameLoop() {
    lutDrawScheduled = false;
    if (!lutActive()) return;
    lutRenderer.draw(video);
    scheduleLutFrame();
  }
  function scheduleLutFrame() {
    if (lutDrawScheduled || !lutActive()) return;
    lutDrawScheduled = true;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) video.requestVideoFrameCallback(lutFrameLoop);
    else requestAnimationFrame(lutFrameLoop);
  }

  function applyLutVisibility() {
    const on = lutActive();
    video.classList.toggle('lut-active', on);
    lutCanvas.classList.toggle('hidden', !on);
    lutBadge.classList.toggle('hidden', !on);
    if (on) {
      lutRenderer.setEnabled(true);
      lutBadge.textContent = 'LUT ' + (lookState.lutPath || '').split(/[\\/]/).pop();
      drawLutFrame();
      scheduleLutFrame();
    } else if (lutRenderer) {
      lutRenderer.setEnabled(false);
    }
  }

  async function applyLookState(state) {
    const prev = lookState;
    lookState = Object.assign({}, lookState, state || {});

    // LUT
    await loadLutIntoGpu(lookState.lutPath);
    applyLutVisibility();
    // The SDI output applies the LUT in its own ffmpeg chain; a change in
    // what it should get means a restart from the current position.
    const sdiLut = (lookState.lutEnabled && lookState.lutToSdi && lookState.lutPath) || null;
    if (sdiActive && sdiLut !== lastSdiLut) sdiRestart();
    lastSdiLut = sdiLut;

    // Masks
    let ratio = null, label = null;
    if (lookState.maskPreset === 'custom') { ratio = Number(lookState.maskCustomRatio) || null; label = ratio ? ratio.toFixed(2) : null; }
    else if (lookState.maskPreset) {
      const p = MASK_PRESETS.find((k) => k.key === lookState.maskPreset);
      if (p) { ratio = p.ratio; label = p.label; }
    }
    masks.setState({ ratio, label, opacity: lookState.maskOpacity, crosshair: lookState.crosshair, actionSafe: lookState.actionSafe, titleSafe: lookState.titleSafe });

    renderLookPanel();
    if (prev.lutPath !== lookState.lutPath || prev.lutEnabled !== lookState.lutEnabled) updateExportNote();
  }

  function renderLookPanel() {
    const name = lookState.lutPath ? lookState.lutPath.split(/[\\/]/).pop() : null;
    lookLutName.textContent = name || 'No LUT loaded';
    lookLutName.title = lookState.lutPath || '';
    lookLutEnabled.checked = !!lookState.lutEnabled;
    lookLutEnabled.disabled = !lookState.lutPath;
    lookLutSdi.checked = !!lookState.lutToSdi;
    if (lutLoadedInfo && lookState.lutPath) {
      lookLutNote.textContent = (lutLoadedInfo.title ? '"' + lutLoadedInfo.title + '" — ' : '') +
        (lutLoadedInfo.is3D ? lutLoadedInfo.size + '×' + lutLoadedInfo.size + '×' + lutLoadedInfo.size + ' 3D' : '1D, ' + lutLoadedInfo.size + ' points') +
        (lutRenderer && lutRenderer.precision ? ' · GPU ' + lutRenderer.precision : '') +
        '. Applied to the display picture; SDI, exports and saved frames use ffmpeg lut3d (tetrahedral).';
    } else {
      lookLutNote.textContent = 'Load a .cube (1D or 3D). U toggles it during playback.';
    }

    maskPresetsEl.innerHTML = '';
    const off = document.createElement('button');
    off.className = 'mask-preset' + (!lookState.maskPreset ? ' active' : '');
    off.textContent = 'Off';
    off.addEventListener('click', () => window.electronAPI.lookUpdate({ maskPreset: null }));
    maskPresetsEl.appendChild(off);
    for (const p of MASK_PRESETS) {
      const b = document.createElement('button');
      b.className = 'mask-preset' + (lookState.maskPreset === p.key ? ' active' : '');
      b.textContent = p.label;
      b.addEventListener('click', () => window.electronAPI.lookUpdate({ maskPreset: p.key }));
      maskPresetsEl.appendChild(b);
    }
    if (document.activeElement !== maskCustomInput) maskCustomInput.value = Number(lookState.maskCustomRatio || 2).toFixed(2);
    document.getElementById('btn-mask-custom').classList.toggle('active', lookState.maskPreset === 'custom');
    maskOpacityInput.value = String(lookState.maskOpacity);
    maskOpacityValue.textContent = Math.round(lookState.maskOpacity * 100) + '%';
    guideCrosshair.checked = !!lookState.crosshair;
    guideAction.checked = !!lookState.actionSafe;
    guideTitle.checked = !!lookState.titleSafe;
  }

  function toggleLut() {
    if (!lookState.lutPath) { window.electronAPI.openLutDialog(); return; }
    window.electronAPI.lookUpdate({ lutEnabled: !lookState.lutEnabled });
  }

  function toggleLookPanel(force) {
    if (force && force.show) { togglePanel(lookPanel); if (lookPanel.classList.contains('hidden')) lookPanel.classList.remove('hidden'); return; }
    togglePanel(lookPanel);
  }

  btnLook.addEventListener('click', () => toggleLookPanel());
  document.getElementById('btn-close-look').addEventListener('click', () => lookPanel.classList.add('hidden'));
  document.getElementById('btn-look-load-lut').addEventListener('click', () => window.electronAPI.openLutDialog());
  document.getElementById('btn-look-clear-lut').addEventListener('click', () => window.electronAPI.lookUpdate({ lutPath: null, lutEnabled: false }));
  lookLutEnabled.addEventListener('change', () => window.electronAPI.lookUpdate({ lutEnabled: lookLutEnabled.checked }));
  lookLutSdi.addEventListener('change', () => window.electronAPI.lookUpdate({ lutToSdi: lookLutSdi.checked }));
  document.getElementById('btn-mask-custom').addEventListener('click', () => {
    const v = parseFloat(maskCustomInput.value);
    if (!(v > 0.2 && v < 5)) { alert('Enter an aspect ratio between 0.20 and 5.00 (width ÷ height).'); return; }
    window.electronAPI.lookUpdate({ maskPreset: 'custom', maskCustomRatio: v });
  });
  maskCustomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('btn-mask-custom').click(); e.stopPropagation(); });
  maskOpacityInput.addEventListener('input', () => {
    // Live preview while dragging; the persisted update follows on release.
    masks.setState({ opacity: parseFloat(maskOpacityInput.value) });
    maskOpacityValue.textContent = Math.round(parseFloat(maskOpacityInput.value) * 100) + '%';
  });
  maskOpacityInput.addEventListener('change', () => window.electronAPI.lookUpdate({ maskOpacity: parseFloat(maskOpacityInput.value) }));
  guideCrosshair.addEventListener('change', () => window.electronAPI.lookUpdate({ crosshair: guideCrosshair.checked }));
  guideAction.addEventListener('change', () => window.electronAPI.lookUpdate({ actionSafe: guideAction.checked }));
  guideTitle.addEventListener('change', () => window.electronAPI.lookUpdate({ titleSafe: guideTitle.checked }));
  window.addEventListener('resize', () => masks.redraw());
  new ResizeObserver(() => masks.redraw()).observe(document.getElementById('video-container'));

  window.electronAPI.onLookState((state) => { applyLookState(state); });
  window.electronAPI.lookGet().then((state) => applyLookState(state)).catch(() => {});

  // ─── Commands from the menus ───────────────────────────────────────────

  function closeEditingUi() {
    exportDialog.classList.add('hidden');
    muteDialog.classList.add('hidden');
    markersPanel.classList.add('hidden');
    combinePanel.classList.add('hidden');
    lookPanel.classList.add('hidden');
  }

  window.electronAPI.onEditCommand((name, payload) => {
    switch (name) {
      case 'set-in': setInPoint(); break;
      case 'set-out': setOutPoint(); break;
      case 'go-in': goToIn(); break;
      case 'go-out': goToOut(); break;
      case 'clear-in-out': clearInOut(); break;
      case 'play-selection': playSelection(); break;
      case 'export': openExportDialog(payload || {}); break;
      case 'delete-selection': deleteSelection(); break;
      case 'copy-selection': copySelectionToBin(); break;
      case 'append-movie': appendMovie(); break;
      case 'toggle-combine-panel': togglePanel(combinePanel); break;
      case 'save-frame': saveCurrentFrame(); break;
      case 'audio-op': audioOp(payload || {}); break;
      case 'add-marker': addMarker(); break;
      case 'delete-marker': deleteMarkerAtPlayhead(); break;
      case 'next-marker': nextMarker(); break;
      case 'prev-marker': prevMarker(); break;
      case 'toggle-markers-panel': togglePanel(markersPanel); renderMarkersPanelActive(); break;
      case 'export-markers': exportMarkers(); break;
      case 'clear-markers': clearMarkers(); break;
      case 'toggle-look-panel': toggleLookPanel(payload); break;
      default: console.warn('[Edit] Unknown command:', name);
    }
  });

  updateSelectionUI();

  // ─── Fullscreen Polling ───────────────────────────────

  const checkFullscreen = async () => {
    const isFs = await window.electronAPI.isFullscreen();
    iconFsEnter.classList.toggle('hidden', isFs);
    iconFsExit.classList.toggle('hidden', !isFs);
  };
  setInterval(checkFullscreen, 1000);

  // ─── Initial State ────────────────────────────────────
  updateVolumeIcon();
  updatePlayButton();
  console.log('[Renderer] MaidenPlayer v1.4.0 initialized');

})();
