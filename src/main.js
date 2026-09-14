const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const transcoder = require('./transcoder');
const inspector = require('./inspector');
const loudness = require('./loudness');
const captions = require('./captions');
const { StreamDecoder } = require('./stream-decoder');
const braw = require('./braw');
const sdi = require('./sdi');
const { autoUpdater } = require('electron-updater');

let mainWindow = null;
let streamDecoder = null; // Singleton stream decoder instance

// ─── External video output (Blackmagic SDI) ───────────────────────────────
// The equivalent of RV's "Present Mode": pick a DeckLink / UltraStudio in the
// Playback menu and playback is routed out of it over SDI. The renderer owns
// the transport and tells us when to start, pause, resume and stop; the clock
// itself lives in the sdi-out helper process (see src/sdi.js for why).
let sdiOutput = null;          // active sdi.SdiOutput, or null
let sdiDevices = [];           // last enumeration from the helper
let sdiSelectedIndex = -1;     // device index, or -1 for the built-in display
let sdiLastScan = null;        // full result of the last enumeration, for diagnostics

function sdiSelectedDevice() {
  return sdiDevices.find((d) => d.index === sdiSelectedIndex) || null;
}

async function refreshSdiDevices() {
  sdiLastScan = await sdi.listDevicesDetailed();
  sdiDevices = sdiLastScan.devices || [];
  if (sdiLastScan.error) console.error('[SDI] Device enumeration:', sdiLastScan.error);
  if (sdiLastScan.stderr) console.log('[SDI] helper said:\n' + sdiLastScan.stderr.trim());
  // A device that has been unplugged must not stay selected.
  if (sdiSelectedIndex !== -1 && !sdiSelectedDevice()) selectSdiDevice(-1);
  buildMenu();
}

function selectSdiDevice(index) {
  sdiSelectedIndex = index;
  buildMenu();
  if (mainWindow) mainWindow.webContents.send('sdi-device-changed', sdiSelectedDevice());
}

/** The Playback ▸ External Video Output submenu, rebuilt on every enumeration. */
function sdiOutputSubmenu() {
  if (!sdi.isAvailable()) {
    return [{ label: 'SDI output is not installed in this build', enabled: false }];
  }
  const items = [
    {
      label: 'Built-in Display',
      type: 'radio',
      checked: sdiSelectedIndex === -1,
      click: () => selectSdiDevice(-1),
    },
  ];
  if (sdiDevices.length === 0) {
    // "Found but unusable" and "not found" have different fixes; do not let
    // them share a label.
    items.push({
      label: sdiDevicesSeen() > 0 ? 'Blackmagic device found, but it has no usable output' : 'No Blackmagic device found',
      enabled: false,
    });
    // Put the helper's own one-line reason right in the menu, so the first
    // screenshot from a screening room already says why.
    const reason = sdiScanReason();
    if (reason) items.push({ label: '   ' + reason, enabled: false });
  }
  for (const d of sdiDevices) {
    items.push({
      label: d.name,
      type: 'radio',
      checked: sdiSelectedIndex === d.index,
      click: () => selectSdiDevice(d.index),
    });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'Refresh Devices', click: () => refreshSdiDevices() });
  items.push({ label: 'Output Diagnostics…', click: () => showSdiDiagnostics() });
  return items;
}

/** The single most useful line from the last scan, for the menu. */
function sdiScanReason() {
  if (!sdiLastScan) return null;
  if (sdiLastScan.error) return sdiLastScan.error.split('\n')[0].slice(0, 90);
  const failLine = (sdiLastScan.stderr || '').split('\n').map((l) => l.trim())
    .filter((l) => l.startsWith('sdi-out:')).pop();
  return failLine ? failLine.replace(/^sdi-out:\s*/, '').slice(0, 90) : null;
}

/** How many devices the driver reported in the last scan, usable or not. */
function sdiDevicesSeen() {
  const m = /diag:devices-seen (\d+)/.exec((sdiLastScan && sdiLastScan.stderr) || '');
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Everything the helper said, in a dialog. Meant to be screenshotted by
 * someone standing at a rig we cannot see.
 */
async function showSdiDiagnostics() {
  await refreshSdiDevices();
  const r = sdiLastScan || {};
  const lines = [
    'Helper: ' + (r.helper || 'not found in this build'),
    'Exit: ' + (r.signal ? 'killed by ' + r.signal : (r.code === null ? 'did not run' : 'code ' + r.code)),
    'Devices: ' + (r.devices ? r.devices.length : 0),
    '',
    '— helper stderr —',
    (r.stderr || '').trim() || '(nothing)',
    '',
    '— helper stdout —',
    (r.stdout || '').trim() || '(nothing)',
  ];
  if (r.error) lines.splice(3, 0, 'Error: ' + r.error);
  const detail = lines.join('\n');
  console.log('[SDI] Diagnostics:\n' + detail);
  if (!mainWindow) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: r.devices && r.devices.length ? 'info' : 'warning',
    title: 'External Video Output — Diagnostics',
    message: r.devices && r.devices.length
      ? r.devices.length + ' Blackmagic device(s) found'
      : sdiDevicesSeen() > 0
        ? sdiDevicesSeen() + ' Blackmagic device(s) found, but none can be used for output — see the reason below'
        : 'No Blackmagic device found',
    detail,
    buttons: ['Copy to Clipboard', 'Close'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) require('electron').clipboard.writeText(detail);
}

// All supported extensions (native + transcoded + image sequences)
const VIDEO_EXTENSIONS = [
  '.mp4', '.webm', '.mkv', '.avi', '.mov', '.m4v', '.ogv', '.ogg',
  '.flv', '.wmv', '.mpg', '.mpeg', '.mxf',
  // Professional containers: MPEG-2 transport/program streams, GXF, ASF,
  // Motion JPEG 2000. Everything here demuxes in the bundled FFmpeg and is
  // routed through the stream decoder rather than the <video> element.
  '.ts', '.m2ts', '.mts', '.m2v', '.mpv', '.vob', '.gxf', '.asf', '.mj2',
  '.3gp', '.3g2',
  // Blackmagic RAW. Unlike everything above it, FFmpeg cannot open this at
  // all, so it is probed and decoded through src/braw.js instead.
  ...braw.BRAW_EXTENSIONS,
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
          label: 'Loop Playback',
          // Cmd-L, as in QuickTime. Bare L stays shuttle forward (J/K/L), so
          // this one IS registered rather than only hinted.
          accelerator: 'CmdOrCtrl+L',
          click: () => {
            if (mainWindow) mainWindow.webContents.send('toggle-loop');
          },
        },
        {
          // Present Mode, in RV's terms: route playback out of a Blackmagic
          // device over SDI. Devices are enumerated by the sdi-out helper.
          label: 'External Video Output',
          submenu: sdiOutputSubmenu(),
        },
        { type: 'separator' },
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
          label: 'Jump Forward 1s',
          ...hint('CmdOrCtrl+Right'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('seek-relative', 1);
          },
        },
        {
          label: 'Jump Backward 1s',
          ...hint('CmdOrCtrl+Left'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('seek-relative', -1);
          },
        },
        { type: 'separator' },
        {
          label: 'Next Frame',
          ...hint('Right'),
          click: () => {
            if (mainWindow) mainWindow.webContents.send('frame-step', 1);
          },
        },
        {
          label: 'Previous Frame',
          ...hint('Left'),
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
          // Cmd/Ctrl+L now belongs to Loop Playback. Shift+L keeps the "L for
          // loudness" mnemonic and is one modifier away from the old key.
          accelerator: 'CmdOrCtrl+Shift+L',
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
              title: 'About MaidenPlayer',
              message: `MaidenPlayer v${app.getVersion()}`,
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
          '3gp', '3g2', 'braw',
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
    // .braw has no FFmpeg demuxer — probing it with ffmpeg reports an invalid
    // file rather than a codec, so the Blackmagic decoder answers instead.
    if (braw.isBrawFile(filePath)) {
      const info = await braw.probe(filePath);
      console.log('[Main] Probe result: braw', info.codecFriendly, info.width + 'x' + info.height);
      return info;
    }

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
    // inspector.js is ffprobe-based, and ffprobe cannot read .braw. Return the
    // decoder's own metadata rather than an ffprobe parse failure.
    if (braw.isBrawFile(filePath)) {
      return await braw.inspect(filePath);
    }

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

// Backpressure: the renderer asks the decoder to hold off once it has enough
// media buffered ahead, so a fast decode cannot saturate the UI thread.
ipcMain.handle('set-stream-flow', async (_event, shouldFlow) => {
  if (!streamDecoder) return false;
  if (shouldFlow) streamDecoder.resumeFlow();
  else streamDecoder.pauseFlow();
  return true;
});

// ─── SDI output IPC ────────────────────────────────────────────────────────

ipcMain.handle('sdi-get-state', async () => ({
  available: sdi.isAvailable(),
  device: sdiSelectedDevice(),
}));

/**
 * Start routing the current media to the selected device.
 * opts: { source, isImageSequence, startFrame, startTime, loop, startPaused,
 *         width, height, fps }
 */
ipcMain.handle('sdi-start', async (_event, opts) => {
  const device = sdiSelectedDevice();
  if (!device) return { error: 'No external video device is selected.' };

  // Ask the DEVICE which of its modes fits — never the static table, since the
  // card is the authority on what it can drive.
  const mode = sdi.chooseDeviceMode(device, { width: opts.width, height: opts.height, fps: opts.fps });
  if (!mode) {
    return { error: device.name + ' offers no output mode for ' + opts.width + 'x' + opts.height +
                    ' at ' + opts.fps + ' fps over SDI.' };
  }

  if (sdiOutput) sdiOutput.stop();
  sdiOutput = new sdi.SdiOutput();

  const send = (payload) => { if (mainWindow) mainWindow.webContents.send('sdi-status', payload); };
  let holdOnFirstPlay = !!opts.startPaused;
  sdiOutput.onStatus = (st) => {
    const state = st.split(' ')[0];
    if (state === 'playing' && holdOnFirstPlay) {
      // Media is paused in the player: preroll, then hold the first frame.
      holdOnFirstPlay = false;
      sdiOutput.pause();
    }
    send({ state, detail: st, device: device.name, mode: mode.name });
  };
  sdiOutput.onError = (msg) => send({ state: 'error', detail: msg, device: device.name, mode: mode.name });
  sdiOutput.onEnd = () => send({ state: 'ended', device: device.name, mode: mode.name });

  const ok = sdiOutput.start({
    deviceIndex: device.index,
    mode,
    source: opts.source,
    isImageSequence: !!opts.isImageSequence,
    startFrame: opts.startFrame,
    startTime: opts.startTime,
    loop: !!opts.loop,
  });
  if (!ok) return { error: sdi.MISSING_HELPER_MESSAGE };
  console.log('[SDI] Started:', device.name, mode.name, opts.source);
  return { ok: true, mode: mode.name, device: device.name };
});

ipcMain.handle('sdi-stop', async () => { if (sdiOutput) { sdiOutput.stop(); sdiOutput = null; } return { ok: true }; });
ipcMain.handle('sdi-pause', async () => { if (sdiOutput) sdiOutput.pause(); return { ok: true }; });
ipcMain.handle('sdi-resume', async () => { if (sdiOutput) sdiOutput.resume(); return { ok: true }; });

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
      message: `MaidenPlayer ${info.version} has been downloaded.`,
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
    message: `MaidenPlayer ${app.getVersion()} is the latest version.`,
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
    message: `MaidenPlayer ${info.version} is available.`,
    detail: 'It is downloading now. You will be prompted to restart when it is ready.',
    buttons: ['OK'],
  });
});

/**
 * One sentence a person can act on, instead of electron-updater's message —
 * which for a 404 is a stack trace with the HTTP headers attached and a note
 * to "double check that your authentication token is correct", none of which
 * applies to a public repo.
 *
 * The 404 case is the one that actually happened: the release existed but
 * its manifest had not been uploaded yet. Releases are drafts until complete
 * now (see the publish job in .github/workflows/build.yml), but a check can
 * still land in the seconds it takes GitHub to flip one public.
 */
function updateErrorDetail(err) {
  const msg = (err && err.message) || String(err);
  if (/\b404\b|Cannot find latest/i.test(msg)) {
    const m = /\/download\/v?(\d+\.\d+\.\d+)\//.exec(msg);
    return (m ? 'MaidenPlayer ' + m[1] + ' is being published right now' : 'A new version is being published right now')
      + ' and its update files are not all there yet. Try again in a few minutes.';
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|net::ERR_/i.test(msg)) {
    return 'GitHub could not be reached. Check the internet connection and try again.';
  }
  // Anything else: the first line only. The rest is in the log.
  return msg.split('\n')[0].slice(0, 200);
}

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
        detail: updateErrorDetail(err),
      });
    }
  });
}

// ──────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────

app.setAsDefaultProtocolClient('maidenplayer');

if (process.platform === 'win32') {
  app.setAppUserModelId('com.maidenplayer.app');
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

// SDI: find devices once the app is up, and release the card when it quits —
// an output left enabled keeps the projector on our last frame.
app.whenReady().then(() => { refreshSdiDevices(); });
app.on('before-quit', () => { if (sdiOutput) { sdiOutput.stop(); sdiOutput = null; } });
