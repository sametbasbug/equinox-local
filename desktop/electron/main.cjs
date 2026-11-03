// Development-only Electron shell. The existing local runtime owns all privileged capabilities.
const path = require('node:path');
const { app, BrowserWindow, shell, session } = require('electron');

const CONTROL_CENTER = 'http://127.0.0.1:24891/';
const origin = new URL(CONTROL_CENTER).origin;
const unavailable = path.join(__dirname, 'unavailable.html');

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

function createWindow() {
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
      webSecurity: true,
      webviewTag: false
    }
  });

  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => {
    console.log(isControlCenterUrl(win.webContents.getURL())
      ? 'Electron desktop preview: Control Center loaded.'
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
  win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !win.isDestroyed()) {
      void win.loadFile(unavailable);
    }
  });

  void win.loadURL(CONTROL_CENTER);
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setName('Equinox Local');
  // Keep alpha-preview Chromium state separate from the installed native shell.
  app.setPath('userData', path.join(app.getPath('appData'), 'Equinox Local Desktop Preview'));
  app.on('second-instance', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    // No arbitrary device privileges are granted to remote or renderer content.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(permission === 'clipboard-sanitized-write' && isControlCenterUrl(details.requestingUrl));
    });
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
