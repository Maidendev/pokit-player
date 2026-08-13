const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const transcoder = require('./transcoder');
const inspector = require('./inspector');
const loudness = require('./loudness');
const captions = require('./captions');
const { StreamDecoder } = require('./stream-decoder');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let streamDecoder = null; // Singleton stream decoder instance

// All supported extensions (native + transcoded + image sequences)
const VIDEO_EXTENSIONS = [
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv', '.ogg',
  '.flv', '.wmv', '.mpg', '.mpeg', '.mxf',
  // Professional containers: MPEG-2 transport/program streams, GXF, ASF,
  // Motion JPEG 2000. Everything here demuxes in the bundled FFmpeg and is
  // routed through the stream decoder rather than the <video> element.
  '.ts', '.m2ts', '.mts', '.m2v', '.mpv', '.vob', '.gxf', '.asf', '.mj2',
  '.3gp', '.3g2',
];
const IMAGE_SEQ_EXTENSIONS = transcoder.IMAGE_SEQ_EXTENSIONS; // .dpx .exr .tif .tiff .png .jpg .jpeg
const ALL_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_SEQ_EXTENSIONS];

function getIconPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, 'assets', 'icon.ico');
  }
  return path.join(__dirname, 'assets', 'icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1a1a1a',
    icon: getIconPath(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Handle file open from command line arguments
  const filePath = getFileFromArgs(process.argv);
  if (filePath) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('open-file', filePath);
    });
  }

  buildMenu();
}

function getFileFromArgs(argv) {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) continue;
    const ext = path.extname(arg).toLowerCase();
    if (ALL_EXTENSIONS.includes(ext) && fs.existsSync(arg)) {
      return arg;
    }
  }
  return null;
}

function buildMenu() {
  // Playback keys (Space, J/K/L, arrows, F, M) are owned by the renderer's
  // keydown handler so the J/K/L shuttle keeps a single source of truth.
  // Registering the same keys as menu accelerators fires both handlers, which
  // cancel each other out — Space would play and immediately pause again.
  // macOS can show the accelerator in the menu without registering it; on
  // Windows/Linux registerAccelerator is ignored, so the key is omitted there.
  const hint = (accel) =>
    (process.platform === 'darwin' ? { accelerator: accel, registerAccelerator: false } : {});

  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Open File…',
          accelerator: 'CmdOrCtrl+O',
          click: () => openFileDialog(),
        },
        {
          label: 'Open Image Sequence…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: () => openImageSequenceDialog(),
        },
        { type: 'separator' },
        {
          label: 'Load Caption / Subtitle File…',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('load-caption-file');
          },
        },
        {
          label: 'Extract Embedded Captions (CEA-608)',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('extract-embedded-captions');
          },
        },
        {
          label: 'Load Secondary Audio…',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('load-secondary-audio');
          },
        },
        { type: 'separator' },
        {
          label: 'File Info',
          accelerator: 'CmdOrCtrl+I',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('toggle-file-info');
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Playback',
      submenu: [
        {
          label: 'Play / Pause',
          ...hint('Space'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('playback-toggle');
          },
        },
        {
          label: 'Shuttle Forward',
          ...hint('L'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('shuttle', 1);
          },
        },
        {
          label: 'Shuttle Backward',
          ...hint('J'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('shuttle', -1);
          },
        },
        { type: 'separator' },
        {
          label: 'Skip Forward 5s',
          ...hint('Right'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('seek-relative', 5);
          },
        },
        {
          label: 'Skip Backward 5s',
          ...hint('Left'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('seek-relative', -5);
          },
        },
        { type: 'separator' },
        {
          label: 'Next Frame',
          ...hint('CmdOrCtrl+Right'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('frame-step', 1);
          },
        },
        {
          label: 'Previous Frame',
          ...hint('CmdOrCtrl+Left'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('frame-step', -1);
          },
        },
        { type: 'separator' },
        {
          label: 'Volume Up',
          ...hint('Up'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('volume-change', 0.05);
          },
        },
        {
          label: 'Volume Down',
          ...hint('Down'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('volume-change', -0.05);
          },
        },
        {
          label: 'Mute / Unmute',
          ...hint('M'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('toggle-mute');
          },
        },
        { type: 'separator' },
        {
          label: 'Toggle Fullscreen',
          ...hint('F'),
          click: () => {
            if (mainWindow) {
              mainWindow.setFullScreen(!mainWindow.isFullScreen());
            }
          },
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Quarter Size (25%)',
          accelerator: 'CmdOrCtrl+1',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('set-window-size', 0.25);
          },
        },
        {
          label: 'Half Size (50%)',
          accelerator: 'CmdOrCtrl+2',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('set-window-size', 0.5);
          },
        },
        {
          label: 'Full Size (100%)',
          accelerator: 'CmdOrCtrl+3',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('set-window-size', 1.0);
          },
        },
        { type: 'separator' },
        {
          label: 'GOP / Data Rate Strip',
          accelerator: 'CmdOrCtrl+G',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('toggle-gop-strip');
          },
        },
        {
          label: 'Audio Meters & Loudness',
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('toggle-audio-panel');
          },
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Keyboard Shortcuts',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('show-shortcuts');
          },
        },
        { type: 'separator' },
        {
          label: 'Check for Updates…',
          click: () => checkForUpdates(true),
        },
        { type: 'separator' },
        {
          label: 'About',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About PokitPlayer',
              message: `PokitPlayer v${app.getVersion()}`,
              detail:
                'A professional cross-platform video player.\n' +
                'Supports ProRes, DNxHD/DNxHR, image sequences, and more.\n' +
                'Instant streaming playback — no transcode wait.\n' +
                'Source timecode display from embedded metadata.\n' +
                'Built with Electron + ffmpeg.\n\nMIT License',
            });
          },
        },
      ],
    },
  ];

  if (process.platform === 'darwin') {
    template.unshift({
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ──────────────────────────────────────────────
// File dialogs
// ──────────────────────────────────────────────

async function openFileDialog() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Video File',
    properties: ['openFile'],
    filters: [
      {
        name: 'Video Files',
        extensions: [
          'mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogv', 'ogg',
          'flv', 'wmv', 'mpg', 'mpeg', 'mxf',
          'ts', 'm2ts', 'mts', 'm2v', 'mpv', 'vob', 'gxf', 'asf', 'mj2',
          '3gp', '3g2',
        ],
      },
      {
        name: 'Image Sequence Files',
        extensions: ['dpx', 'exr', 'tif', 'tiff', 'png', 'jpg', 'jpeg'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('open-file', result.filePaths[0]);
  }
}

async function openImageSequenceDialog() {
  if (!mainWindow) return;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Image Sequence (select any frame)',
    properties: ['openFile'],
    filters: [
      {
        name: 'Image Sequence Files',
        extensions: ['dpx', 'exr', 'tif', 'tiff', 'png', 'jpg', 'jpeg'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (!result.canceled && result.filePaths.length > 0) {
    mainWindow.webContents.send('open-image-sequence', result.filePaths[0]);
  }
}

// ──────────────────────────────────────────────
// IPC Handlers
// ──────────────────────────────────────────────

ipcMain.handle('open-file-dialog', async () => {
  await openFileDialog();
});

ipcMain.handle('open-image-sequence-dialog', async () => {
  await openImageSequenceDialog();
});

ipcMain.handle('get-file-stats', async (_event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      size: stats.size,
      created: stats.birthtime.toISOString(),
      modified: stats.mtime.toISOString(),
      name: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase().replace('.', ''),
      directory: path.dirname(filePath),
    };
  } catch (err) {
    return null;
  }
});

// Probe file codec info
ipcMain.handle('probe-file', async (_event, filePath) => {
  console.log('[Main] IPC: probe-file', filePath);
  try {
    const result = await transcoder.probeFile(filePath);
    console.log('[Main] Probe result:', result.codec, result.codecFriendly, 'transcode:', result.needsTranscode);
    return result;
  } catch (err) {
    console.error('[Main] Probe error:', err.message);
    return { error: err.message };
  }
});

// Deep inspection for the "Check It" panel (ffprobe JSON, not the playback probe)
ipcMain.handle('inspect-file', async (_event, filePath) => {
  console.log('[Main] IPC: inspect-file', filePath);
  try {
    return await inspector.inspectFile(filePath);
  } catch (err) {
    console.error('[Main] Inspect error:', err.message);
    return { error: err.message };
  }
});

// Per-frame picture types + sizes for the GOP / data-rate strip
ipcMain.handle('probe-frames', async (_event, filePath, startTime, duration) => {
  try {
    return await inspector.probeFrames(filePath, startTime, duration);
  } catch (err) {
    console.error('[Main] Frame probe error:', err.message);
    return { error: err.message };
  }
});

// Whether deep inspection is usable at all, so the UI can degrade gracefully
ipcMain.handle('inspector-available', async () => inspector.isAvailable());

// Offline program-loudness measurement (BS.1770 via ebur128)
ipcMain.handle('measure-loudness', async (event, filePath, options) => {
  console.log('[Main] IPC: measure-loudness', filePath, options);
  try {
    const measurement = await loudness.measureLoudness(filePath, Object.assign({}, options, {
      onProgress: (pct) => {
        if (!event.sender.isDestroyed()) event.sender.send('loudness-progress', pct);
      },
    }));
    return measurement;
  } catch (err) {
    console.error('[Main] Loudness error:', err.message);
    return { error: err.message };
  }
});

// Load a sidecar caption/subtitle file (§3)
ipcMain.handle('load-caption-file', async (_event, filePath, fps) => {
  console.log('[Main] IPC: load-caption-file', filePath);
  try {
    return captions.loadSidecar(filePath, fps);
  } catch (err) {
    console.error('[Main] Caption load error:', err.message);
    return { error: err.message };
  }
});

// Extract embedded CEA-608 captions from the media file itself (§3)
ipcMain.handle('extract-embedded-captions', async (_event, filePath) => {
  console.log('[Main] IPC: extract-embedded-captions', filePath);
  try {
    const outputPath = transcoder.makeTempPath('.srt');
    return await captions.extractEmbedded608(filePath, outputPath);
  } catch (err) {
    console.error('[Main] Embedded caption error:', err.message);
    return { error: err.message };
  }
});

// Pick a sidecar caption file
ipcMain.handle('open-caption-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Caption / Subtitle File',
    properties: ['openFile'],
    filters: [
      {
        name: 'Caption & Subtitle Files',
        extensions: ['srt', 'vtt', 'webvtt', 'scc', 'ttml', 'itt', 'dfxp', 'xml', 'stl'],
      },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Pick a secondary audio file for sync checking (§5)
ipcMain.handle('open-secondary-audio-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Load Secondary Audio File',
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: ['wav', 'aiff', 'aif', 'mp3', 'aac', 'm4a', 'flac', 'mxf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('check-loudness-target', async (_event, measurement, targetKey) => {
  try {
    return loudness.checkAgainstTarget(measurement, targetKey);
  } catch (err) {
    return { error: err.message };
  }
});

// Transcode ProRes/DNX/etc. to H.264
ipcMain.handle('transcode-file', async (event, filePath) => {
  console.log('[Main] IPC: transcode-file', filePath);
  try {
    const probe = await transcoder.probeFile(filePath);
    if (!probe.needsTranscode) {
      console.log('[Main] File does not need transcoding');
      return { outputPath: null, alreadyNative: true, probe };
    }

    console.log('[Main] Starting transcode:', probe.codecFriendly, '→ H.264');
    const outputPath = await transcoder.transcodeToH264(filePath, probe, (pct) => {
      if (mainWindow) mainWindow.webContents.send('transcode-progress', pct);
    });

    console.log('[Main] Transcode complete:', outputPath);
    return { outputPath, alreadyNative: false, probe };
  } catch (err) {
    console.error('[Main] Transcode error:', err.message);
    return { error: err.message };
  }
});

// Detect image sequence from a sample file
ipcMain.handle('detect-image-sequence', async (_event, samplePath) => {
  console.log('[Main] IPC: detect-image-sequence', samplePath);
  try {
    const info = transcoder.detectImageSequence(samplePath);
    console.log('[Main] Sequence detection result:', info ? info.count + ' frames' : 'not a sequence');
    return info; // null if not a sequence
  } catch (err) {
    console.error('[Main] Sequence detection error:', err.message);
    return { error: err.message };
  }
});

// Render image sequence to playable MP4
ipcMain.handle('render-image-sequence', async (_event, seqInfo, fps) => {
  console.log('[Main] IPC: render-image-sequence', seqInfo.count, 'frames @', fps, 'fps');
  try {
    const outputPath = await transcoder.renderImageSequence(seqInfo, fps, (pct) => {
      if (mainWindow) mainWindow.webContents.send('transcode-progress', pct);
    });
    console.log('[Main] Sequence render complete:', outputPath);
    return { outputPath };
  } catch (err) {
    console.error('[Main] Sequence render error:', err.message);
    return { error: err.message };
  }
});

// ──────────────────────────────────────────────
// Stream Decode IPC Handlers (v1.1.0)
// ──────────────────────────────────────────────

ipcMain.handle('start-stream', async (_event, filePath, seekTime = 0) => {
  console.log('[Main] IPC: start-stream', filePath, 'seek:', seekTime);
  try {
    // Probe the file first
    const probe = await transcoder.probeFile(filePath);
    if (probe.error) {
      return { error: probe.error };
    }

    // Create or reuse stream decoder
    if (!streamDecoder) {
      streamDecoder = new StreamDecoder();
    }

    // Wire up callbacks to send data to renderer
    streamDecoder.onData = (chunk) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Send as Buffer (Electron serializes to ArrayBuffer)
        mainWindow.webContents.send('stream-data', chunk);
      }
    };

    streamDecoder.onEnd = () => {
      console.log('[Main] Stream ended');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-end');
      }
    };

    streamDecoder.onError = (msg) => {
      console.error('[Main] Stream error:', msg);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stream-error', msg);
      }
    };

    streamDecoder.onProgress = (time) => {
      // Could send progress updates if needed
    };

    // Start the stream
    streamDecoder.start(filePath, probe, seekTime);

    // Return probe info so renderer knows codec details, duration, audio etc.
    return { probe, seekTime };
  } catch (err) {
    console.error('[Main] start-stream error:', err.message);
    return { error: err.message };
  }
});

ipcMain.handle('stop-stream', async () => {
  console.log('[Main] IPC: stop-stream');
  if (streamDecoder) {
    streamDecoder.stop();
  }
});

ipcMain.handle('seek-stream', async (_event, time) => {
  console.log('[Main] IPC: seek-stream', time);
  if (streamDecoder) {
    streamDecoder.seek(time);
  }
});

ipcMain.handle('toggle-fullscreen', () => {
  if (mainWindow) {
    mainWindow.setFullScreen(!mainWindow.isFullScreen());
    return mainWindow.isFullScreen();
  }
  return false;
});

ipcMain.handle('is-fullscreen', () => {
  return mainWindow ? mainWindow.isFullScreen() : false;
});

ipcMain.handle('set-window-size', (_event, width, height) => {
  if (mainWindow) {
    const extraHeight = 98;
    mainWindow.setSize(Math.round(width), Math.round(height + extraHeight));
    mainWindow.center();
  }
});

// ──────────────────────────────────────────────
// Auto-update (GitHub Releases via electron-updater)
// ──────────────────────────────────────────────

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('error', (err) => {
  console.error('[Updater] error:', err.message);
});

autoUpdater.on('update-downloaded', (info) => {
  if (!mainWindow) return;
  dialog
    .showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `PokitPlayer ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or it will install automatically on quit.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
});

// Set while a user-initiated check is in flight. The automatic check on launch
// must stay silent, but a check the user asked for has to report an outcome —
// otherwise "Check for Updates…" looks broken when you are already current,
// which is the most common case.
let manualUpdateCheck = false;

autoUpdater.on('update-not-available', () => {
  console.log('[Updater] already up to date:', app.getVersion());
  if (!manualUpdateCheck || !mainWindow) return;
  manualUpdateCheck = false;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'No Updates Available',
    message: `PokitPlayer ${app.getVersion()} is the latest version.`,
    buttons: ['OK'],
  });
});

autoUpdater.on('update-available', (info) => {
  console.log('[Updater] update available:', info && info.version);
  if (!manualUpdateCheck || !mainWindow) return;
  manualUpdateCheck = false;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Update Available',
    message: `PokitPlayer ${info.version} is available.`,
    detail: 'It is downloading now. You will be prompted to restart when it is ready.',
    buttons: ['OK'],
  });
});

function checkForUpdates(isManual) {
  manualUpdateCheck = !!isManual;

  // electron-updater rejects on unsigned/unpackaged (dev) runs — don't let an
  // update check crash the app. It also emits 'error'; the dialog lives here
  // rather than in that handler so a failure cannot raise two dialogs.
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Updater] check failed:', err.message);
    if (manualUpdateCheck && mainWindow) {
      manualUpdateCheck = false;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Update Check Failed',
        message: 'Could not check for updates.',
        detail: err.message,
      });
    }
  });
}

// ──────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────

app.setAsDefaultProtocolClient('pokitplayer');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.pokitplayer.app');
}

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) checkForUpdates(false);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send('open-file', filePath);
  }
});

// Cleanup on quit
app.on('will-quit', () => {
  if (streamDecoder) {
    streamDecoder.stop();
    streamDecoder = null;
  }
  transcoder.cleanupTempFiles();
});
