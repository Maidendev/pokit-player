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
    if (video.paused || video.ended) {
      video.play();
    } else {
      video.pause();
    }
  }

  function seekRelative(seconds) {
    if (!hasVideoLoaded) return;
    const target = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + seconds));
    if (streamMode) {
      seekInStream(target);
    } else {
      video.currentTime = target;
    }
  }

  function frameStep(direction) {
    if (!hasVideoLoaded) return;
    video.pause();
    const step = direction * frameDuration;
    const target = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + step));
    if (streamMode) {
      // For frame stepping, try direct seek first (likely within buffer)
      seekInStream(target);
    } else {
      video.currentTime = target;
    }
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
    const playing = !video.paused && !video.ended;
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

  video.addEventListener('play', () => { updatePlayButton(); showControls(); });
  video.addEventListener('pause', () => { updatePlayButton(); showControls(); clearTimeout(controlsTimeout); });
  video.addEventListener('ended', () => { updatePlayButton(); showControls(); });
  video.addEventListener('timeupdate', () => { updateTimecode(); updateTimeline(); updateBuffered(); });
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

  const SUPPORTED_EXTENSIONS = [
    '.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv', '.ogg',
    '.flv', '.wmv', '.mpg', '.mpeg', '.mxf',
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

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;

    if (e.key >= '0' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      jumpToPercent(parseInt(e.key) / 10);
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault(); togglePlay(); break;
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
      case 'f': if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleFullscreen(); } break;
      case 'm': if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); toggleMute(); } break;
      case 'Escape':
        fileInfoPanel.classList.add('hidden');
        shortcutsPanel.classList.add('hidden');
        hideSequenceDialog();
        break;
    }
  });

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
  }

  function updateFileInfoFromVideo() {
    const videoGrid = document.getElementById('info-video');
    videoGrid.innerHTML = '';

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
    valueEl.className = 'info-value';
    valueEl.textContent = value || 'N/A';
    container.appendChild(labelEl);
    container.appendChild(valueEl);
  }

  function getAspectRatio(w, h) {
    const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
    const d = gcd(w, h);
    return (w / d) + ':' + (h / d);
  }

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
  console.log('[Renderer] PokitPlayer v1.1.3 initialized');

})();
