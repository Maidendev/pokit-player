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
  transcodeFile: (filePath) => ipcRenderer.invoke('transcode-file', filePath),
  detectImageSequence: (samplePath) => ipcRenderer.invoke('detect-image-sequence', samplePath),
  renderImageSequence: (seqInfo, fps) => ipcRenderer.invoke('render-image-sequence', seqInfo, fps),

  // Stream decode operations (v1.1.0)
  startStream: (filePath, seekTime) => ipcRenderer.invoke('start-stream', filePath, seekTime),
  stopStream: () => ipcRenderer.invoke('stop-stream'),
  seekStream: (time) => ipcRenderer.invoke('seek-stream', time),

  // Receive events from main process
  onOpenFile: (callback) => ipcRenderer.on('open-file', (_e, path) => callback(path)),
  onOpenImageSequence: (callback) => ipcRenderer.on('open-image-sequence', (_e, path) => callback(path)),
  onPlaybackToggle: (callback) => ipcRenderer.on('playback-toggle', () => callback()),
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
});
