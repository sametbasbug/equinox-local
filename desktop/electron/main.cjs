// Development-only Electron shell. The existing local runtime owns all privileged capabilities.
const path = require('node:path');
const { app, BrowserWindow, Menu, shell, session } = require('electron');

const previewPort = process.env.EQUINOX_DESKTOP_PREVIEW_PORT || '24891';
if (!/^[1-9][0-9]{0,4}$/.test(previewPort) || Number(previewPort) > 65535) {
  throw new Error('Desktop preview port is invalid.');
}
const CONTROL_CENTER = 'http://127.0.0.1:' + previewPort + '/';
const origin = new URL(CONTROL_CENTER).origin;
const WORKSPACE = origin + '/workspace';
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

  void win.loadURL(WORKSPACE);
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
    const go = (url) => {
      const window = BrowserWindow.getAllWindows()[0] || createWindow();
      void window.loadURL(url);
      window.focus();
    };
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
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
