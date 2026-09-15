const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  openImageSequenceDialog: () => ipcRenderer.invoke('open-image-sequence-dialog'),
  getFileStats: (filePath) => ipcRenderer.invoke('get-file-stats', filePath),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),
  setWindowSize: (width, height) => ipcRenderer.invoke('set-window-size', width, height),

  // Transcoder operations
  probeFile: (filePath) => ipcRenderer.invoke('probe-file', filePath),

  // Media Inspector ("Check It")
  inspectFile: (filePath) => ipcRenderer.invoke('inspect-file', filePath),
  probeFrames: (filePath, startTime, duration) =>
    ipcRenderer.invoke('probe-frames', filePath, startTime, duration),
  inspectorAvailable: () => ipcRenderer.invoke('inspector-available'),

  // Loudness (§6)
  measureLoudness: (filePath, options) => ipcRenderer.invoke('measure-loudness', filePath, options),
  checkLoudnessTarget: (measurement, targetKey) =>
    ipcRenderer.invoke('check-loudness-target', measurement, targetKey),
  onLoudnessProgress: (callback) =>
    ipcRenderer.on('loudness-progress', (_e, pct) => callback(pct)),
  onToggleAudioPanel: (callback) => ipcRenderer.on('toggle-audio-panel', () => callback()),

  // Captions & secondary files (§3, §5)
  openCaptionDialog: () => ipcRenderer.invoke('open-caption-dialog'),
  loadCaptionFile: (filePath, fps) => ipcRenderer.invoke('load-caption-file', filePath, fps),
  extractEmbeddedCaptions: (filePath) => ipcRenderer.invoke('extract-embedded-captions', filePath),
  openSecondaryAudioDialog: () => ipcRenderer.invoke('open-secondary-audio-dialog'),
  onLoadCaptionFile: (callback) => ipcRenderer.on('load-caption-file', () => callback()),
  onExtractEmbeddedCaptions: (callback) =>
    ipcRenderer.on('extract-embedded-captions', () => callback()),
  onLoadSecondaryAudio: (callback) => ipcRenderer.on('load-secondary-audio', () => callback()),

  transcodeFile: (filePath) => ipcRenderer.invoke('transcode-file', filePath),
  detectImageSequence: (samplePath) => ipcRenderer.invoke('detect-image-sequence', samplePath),
  renderImageSequence: (seqInfo, fps) => ipcRenderer.invoke('render-image-sequence', seqInfo, fps),

  // Stream decode operations (v1.1.0)
  startStream: (filePath, seekTime) => ipcRenderer.invoke('start-stream', filePath, seekTime),
  stopStream: () => ipcRenderer.invoke('stop-stream'),
  seekStream: (time) => ipcRenderer.invoke('seek-stream', time),
  setStreamFlow: (shouldFlow) => ipcRenderer.invoke('set-stream-flow', shouldFlow),

  // Receive events from main process
  onOpenFile: (callback) => ipcRenderer.on('open-file', (_e, path) => callback(path)),
  onOpenImageSequence: (callback) => ipcRenderer.on('open-image-sequence', (_e, path) => callback(path)),
  onPlaybackToggle: (callback) => ipcRenderer.on('playback-toggle', () => callback()),
  onToggleLoop: (callback) => ipcRenderer.on('toggle-loop', () => callback()),

  // External video output (Blackmagic SDI)
  sdiGetState: () => ipcRenderer.invoke('sdi-get-state'),
  sdiStart: (opts) => ipcRenderer.invoke('sdi-start', opts),
  sdiStop: () => ipcRenderer.invoke('sdi-stop'),
  sdiPause: () => ipcRenderer.invoke('sdi-pause'),
  sdiResume: () => ipcRenderer.invoke('sdi-resume'),
  onSdiDeviceChanged: (callback) => ipcRenderer.on('sdi-device-changed', (_e, device) => callback(device)),
  onSdiStatus: (callback) => ipcRenderer.on('sdi-status', (_e, status) => callback(status)),
  onShuttle: (callback) => ipcRenderer.on('shuttle', (_e, direction) => callback(direction)),
  onToggleGopStrip: (callback) => ipcRenderer.on('toggle-gop-strip', () => callback()),
  onSeekRelative: (callback) => ipcRenderer.on('seek-relative', (_e, seconds) => callback(seconds)),
  onFrameStep: (callback) => ipcRenderer.on('frame-step', (_e, direction) => callback(direction)),
  onVolumeChange: (callback) => ipcRenderer.on('volume-change', (_e, delta) => callback(delta)),
  onToggleMute: (callback) => ipcRenderer.on('toggle-mute', () => callback()),
  onToggleFileInfo: (callback) => ipcRenderer.on('toggle-file-info', () => callback()),
  onShowShortcuts: (callback) => ipcRenderer.on('show-shortcuts', () => callback()),
  onSetWindowSize: (callback) => ipcRenderer.on('set-window-size', (_e, scale) => callback(scale)),
  onTranscodeProgress: (callback) => ipcRenderer.on('transcode-progress', (_e, pct) => callback(pct)),

  // Stream decode events (v1.1.0)
  onStreamData: (callback) => ipcRenderer.on('stream-data', (_e, data) => callback(data)),
  onStreamEnd: (callback) => ipcRenderer.on('stream-end', () => callback()),
  onStreamError: (callback) => ipcRenderer.on('stream-error', (_e, msg) => callback(msg)),
  onStreamReady: (callback) => ipcRenderer.on('stream-ready', (_e, info) => callback(info)),

  // ─── Media editing (QuickTime 7 Pro-style operations) ───────────────────
  // Menu commands arrive as one named channel; the renderer dispatches.
  onEditCommand: (callback) => ipcRenderer.on('edit-command', (_e, name, payload) => callback(name, payload)),
  showSaveDialog: (opts) => ipcRenderer.invoke('show-save-dialog', opts),
  showOpenDialog: (opts) => ipcRenderer.invoke('show-open-dialog', opts),
  editRun: (op, payload) => ipcRenderer.invoke('edit-run', op, payload),
  editCancel: (jobId) => ipcRenderer.invoke('edit-cancel', jobId),
  editDescribe: (source) => ipcRenderer.invoke('edit-describe', source),
  editSnap: (source, inTime, outTime) => ipcRenderer.invoke('edit-snap', source, inTime, outTime),
  editCheckCombine: (entries) => ipcRenderer.invoke('edit-check-combine', entries),
  editPresets: () => ipcRenderer.invoke('edit-presets'),
  onEditProgress: (callback) => ipcRenderer.on('edit-progress', (_e, info) => callback(info)),
  saveTextFile: (filePath, text) => ipcRenderer.invoke('save-text-file', filePath, text),
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),
  revealInFolder: (filePath) => ipcRenderer.invoke('reveal-in-folder', filePath),

  // Clip clipboard: a copied In→Out range travels between windows (separate
  // app processes) on the system clipboard. webCopy/webPaste fall through to
  // ordinary text copy/paste when a text field has focus.
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  clipboardReadText: () => ipcRenderer.invoke('clipboard-read-text'),
  webCopy: () => ipcRenderer.invoke('web-copy'),
  webPaste: () => ipcRenderer.invoke('web-paste'),

  // Look & framing: LUT and aspect-ratio masks. State is owned by main.
  lookGet: () => ipcRenderer.invoke('look-get'),
  lookUpdate: (partial) => ipcRenderer.invoke('look-update', partial),
  openLutDialog: () => ipcRenderer.invoke('open-lut-dialog'),
  onLookState: (callback) => ipcRenderer.on('look-state', (_e, state) => callback(state)),
});
