/**
 * PokitPlayer — Renderer Process v1.1.3
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
    const totalFrames = Math.floor(seconds * fps);
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
        titleText.textContent = fileName + ' — PokitPlayer';
        document.title = fileName + ' — PokitPlayer';
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
    titleText.textContent = fileName + ' — PokitPlayer';
    document.title = fileName + ' — PokitPlayer';

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
    }
    requestAnimationFrame(animationLoop);
  }
  requestAnimationFrame(animationLoop);

  // ─── Controls Auto-Hide ───────────────────────────────

  function showControls() {
    if (!hasVideoLoaded) return;
    controlsBar.classList.remove('hidden');
    controlsBar.classList.add('visible');
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
  btnSkipBack.addEventListener('click', () => seekRelative(-5));
  btnSkipFwd.addEventListener('click', () => seekRelative(5));
  btnPrevFrame.addEventListener('click', () => frameStep(-1));
  btnNextFrame.addEventListener('click', () => frameStep(1));
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
    if (isHidden) panel.classList.remove('hidden');
  }

  // ─── Video Events ─────────────────────────────────────

  video.addEventListener('play', () => {
    updatePlayButton(); showControls(); resyncSecondaryAudio(true);
  });
  video.addEventListener('pause', () => {
    updatePlayButton(); showControls(); clearTimeout(controlsTimeout);
    if (secondaryAudio) secondaryAudio.pause();
  });
  video.addEventListener('ended', () => {
    shuttleDirection = 0;
    shuttleSpeed = 1;
    video.playbackRate = 1;
    updatePlayButton();
    showControls();
  });
  video.addEventListener('timeupdate', () => {
    updateTimecode(); updateTimeline(); updateBuffered();
    if (gopVisible) refreshGopStrip();
    updateCaptionOverlay();
    resyncSecondaryAudio();
  });
  video.addEventListener('seeked', () => {
    activeCueIndex = -1;          // a seek can land anywhere in the cue list
    updateCaptionOverlay();
    resyncSecondaryAudio(true);
  });
  video.addEventListener('loadedmetadata', () => {
    console.log('[Renderer] Video metadata loaded:', video.videoWidth + 'x' + video.videoHeight, 'duration:', video.duration);
    updateTimecode();
    startTimecodeUpdater();
    updateFileInfoFromVideo();
  });
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
      case 'ArrowLeft':
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) frameStep(-1); else seekRelative(-5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) frameStep(1); else seekRelative(5);
        break;
      case 'ArrowUp': e.preventDefault(); changeVolume(0.05); break;
      case 'ArrowDown': e.preventDefault(); changeVolume(-0.05); break;
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
        if (!mod && !e.repeat) { e.preventDefault(); if (kHeld) slowShuttle(1); else shuttleForward(); }
        break;
      case 'KeyF': if (!mod) { e.preventDefault(); toggleFullscreen(); } break;
      case 'KeyM': if (!mod) { e.preventDefault(); toggleMute(); } break;
      case 'Escape':
        fileInfoPanel.classList.add('hidden');
        shortcutsPanel.classList.add('hidden');
        audioPanel.classList.add('hidden');
        hideSequenceDialog();
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

  let audioCtx = null;
  let meterSourceNode = null;  // MediaElementAudioSourceNode (not the MSE MediaSource)
  let channelStrips = [];   // { index, label, analyser, gain, muted, soloed, els }
  let meterRAF = null;

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

    const count = Math.max(1, Math.min(channelCount || 2, 32));
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

      const stripState = {
        index: i, gain, analyser, muted: false, soloed: false,
        els: { fill, peakLine, value, btnMute, btnSolo },
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
    applyChannelRouting();
    startMeterLoop();
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
      if (!audioPanel.classList.contains('hidden') && channelStrips.length) {
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

          s.els.fill.style.height = (dbToMeterFraction(rmsDb) * 100) + '%';
          s.els.fill.classList.toggle('over', peakDb > -0.1);

          // Peak hold decays after 1.5s rather than sticking forever.
          const now = performance.now();
          if (peakDb > s.peakHold || now - s.peakHoldAt > 1500) {
            s.peakHold = peakDb;
            s.peakHoldAt = now;
          }
          s.els.peakLine.style.bottom = (dbToMeterFraction(s.peakHold) * 100) + '%';
          s.els.value.textContent = isFinite(s.peakHold) ? s.peakHold.toFixed(1) : '−∞';
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
      const track = currentInspection && currentInspection.audio && currentInspection.audio[0];
      buildMeters(track ? track.channels : 2, track ? track.speakerLabels : null);
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

  const GOP_COLORS = { I: '#ff9f43', P: '#54a0ff', B: '#8e8e93' };

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
  console.log('[Renderer] PokitPlayer v1.2.2 initialized');

})();
