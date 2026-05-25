const path = require('path');
const { BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

function createWindow({ dev }) {
  const win = new BrowserWindow({
    show: false,
    backgroundColor: '#000000',
    fullscreen: !dev,
    kiosk: !dev,
    frame: dev,
    resizable: dev,
    minimizable: dev,
    maximizable: dev,
    movable: dev,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: dev,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    if (dev) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  return win;
}

module.exports = { createWindow };
