// Development-only Electron shell. The existing local runtime owns all privileged capabilities.
const path = require('node:path');
const { app, BrowserWindow, Menu, Tray, nativeImage, shell, session } = require('electron');

const previewPort = process.env.EQUINOX_DESKTOP_PREVIEW_PORT || '24891';
if (!/^[1-9][0-9]{0,4}$/.test(previewPort) || Number(previewPort) > 65535) {
  throw new Error('Desktop preview port is invalid.');
}
const CONTROL_CENTER = 'http://127.0.0.1:' + previewPort + '/';
const origin = new URL(CONTROL_CENTER).origin;
const WORKSPACE = origin + '/workspace';
const unavailable = path.join(__dirname, 'unavailable.html');

// This is a preview-only UI resident shell. The installed native app continues
// to own runtime startup, login registration, permissions, and signed updates.
let previewTray = null;
let quitting = false;

function revealWindow(url = null) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    createWindow(url || WORKSPACE);
    return;
  }
  if (url && win.webContents.getURL() !== url) void win.loadURL(url);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createPreviewTray() {
  const file = process.platform === 'win32'
    ? path.resolve(__dirname, '../../native/windows/EquinoxLocal.WindowsShell/Assets/EquinoxLocal.ico')
    : path.resolve(__dirname, '../../app/EquinoxLocalMenuBar.png');
  let icon = nativeImage.createFromPath(file);
  // The public release source closure always includes the shared app PNG;
  // the Windows-specific ICO can be absent in a source-only preview bundle.
  if (icon.isEmpty() && process.platform === 'win32') {
    icon = nativeImage.createFromPath(path.resolve(__dirname, '../../app/EquinoxLocal.png'))
      .resize({width: 16, height: 16});
  }
  if (icon.isEmpty()) throw new Error('Preview tray icon unavailable.');
  if (process.platform === 'darwin') {
    icon = icon.resize({width: 18, height: 18});
    icon.setTemplateImage(true);
  }
  previewTray = new Tray(icon);
  previewTray.setToolTip('Equinox Local — Workspace Preview');
  previewTray.setContextMenu(Menu.buildFromTemplate([
    {label: 'Equinox Local · Preview', enabled: false},
    {type: 'separator'},
    {label: 'Çalışma alanını aç', click: () => revealWindow(WORKSPACE)},
    {label: 'Kontrol Merkezi', click: () => revealWindow(CONTROL_CENTER)},
    {type: 'separator'},
    {label: 'Çıkış · Yalnızca önizleme', click: () => { quitting = true; app.quit(); }},
  ]));
  if (process.platform === 'win32') {
    previewTray.on('click', () => revealWindow());
    previewTray.on('double-click', () => revealWindow());
  }
}

function isControlCenterUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === origin && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function isSafeExternalUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function openExternal(raw) {
  if (isSafeExternalUrl(raw)) {
    void shell.openExternal(raw);
  }
}

function createWindow(initialUrl = WORKSPACE) {
  const win = new BrowserWindow({
    title: 'Equinox Local',
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 620,
    backgroundColor: '#101018',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // ChatGPT can take focus while a task chat is created. Keep bounded
      // workspace request and response timers progressing in the background.
      backgroundThrottling: false,
      webSecurity: true,
      webviewTag: false
    }
  });

  // Recover the offline *window* without starting/restarting the runtime or
  // retrying any privileged task/chat mutation. Poll only the fixed loopback
  // Workspace route; never follow a server-provided redirect.
  let offline = false;
  let reconnectTimer = null;
  let probing = false;
  const stopReconnect = () => {
    if (reconnectTimer !== null) clearInterval(reconnectTimer);
    reconnectTimer = null;
  };
  const probeReconnect = async () => {
    if (!offline || probing || win.isDestroyed()) return;
    probing = true;
    try {
      const response = await fetch(WORKSPACE, {
        signal: AbortSignal.timeout(2500),
        redirect: 'error',
        cache: 'no-store'
      });
      await response.body?.cancel();
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return;
      if (!win.isDestroyed() && offline) {
        await win.loadURL(WORKSPACE);
        if (!win.isDestroyed() && win.webContents.getURL() === WORKSPACE) {
          offline = false;
          stopReconnect();
        }
      }
    } catch {
      // An offline runtime is expected; never start a second agent/server.
    } finally {
      probing = false;
    }
  };
  const showUnavailable = () => {
    if (offline || win.isDestroyed()) return;
    offline = true;
    void win.loadFile(unavailable);
    reconnectTimer = setInterval(() => { void probeReconnect(); }, 4000);
  };
  win.on('close', (event) => {
    if (previewTray && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', stopReconnect);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    // Chromium may finish rendering its *error document* for a failed local
    // URL. Never clear reconnect state from this event alone.
    console.log(isControlCenterUrl(win.webContents.getURL())
      ? 'Electron desktop preview: local navigation finished.'
      : 'Electron desktop preview: offline screen loaded.');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isControlCenterUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isControlCenterUrl(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  win.webContents.on('did-fail-load', (_event, code, _description, failedUrl, isMainFrame) => {
    if (isMainFrame && code !== -3 && isControlCenterUrl(failedUrl)) showUnavailable();
  });

  void win.loadURL(initialUrl);
  return win;
}

// Set the profile BEFORE taking Electron's single-instance lock: an unrelated
// Electron development app must not share this preview's lock or Chromium data.
app.setName('Equinox Local Preview');
app.setPath('userData', path.join(app.getPath('appData'), 'Equinox Local Desktop Preview'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('before-quit', () => {
    quitting = true;
    previewTray?.destroy();
    previewTray = null;
  });
  app.on('second-instance', () => revealWindow());
  app.whenReady().then(() => {
    // No arbitrary device privileges are granted to remote or renderer content.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(permission === 'clipboard-sanitized-write' && isControlCenterUrl(details.requestingUrl));
    });
    try {
      createPreviewTray();
    } catch (error) {
      // A missing optional UI icon must not stop a preview or take ownership
      // of the installed application's runtime/lifecycle.
      previewTray?.destroy();
      previewTray = null;
      console.warn('Preview tray unavailable; window-only fallback:', error.message);
    }
    createWindow();
    const go = (url) => revealWindow(url);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: 'Navigate', submenu: [
        { label: 'Workspace', accelerator: 'CmdOrCtrl+1', click: () => go(WORKSPACE) },
        { label: 'Control Center', accelerator: 'CmdOrCtrl+2', click: () => go(CONTROL_CENTER) },
      ] },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]));
    app.on('activate', () => revealWindow());
  });
  app.on('window-all-closed', () => {
    if (!previewTray && process.platform !== 'darwin') app.quit();
  });
}
