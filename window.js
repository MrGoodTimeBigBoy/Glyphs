'use strict';

const { BrowserWindow } = require('electron');
const path = require('path');

/**
 * createWindow({ isDev }) → BrowserWindow
 * Prod: fullscreen kiosk, all escape hatches locked down at the window level.
 * Dev:  windowed 1280×800, normal chrome, devTools enabled.
 */
function createWindow({ isDev } = {}) {
  const prodOptions = {
    fullscreen: true,
    kiosk: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    movable: false,
    autoHideMenuBar: true,
  };

  const devOptions = {
    width: 1280,
    height: 800,
    resizable: true,
  };

  const win = new BrowserWindow({
    backgroundColor: '#000000',
    show: false,
    ...(isDev ? devOptions : prodOptions),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // devTools is one of two layers that block the DevTools UI in prod;
      // the other is chord-swallowing in containment.js.
      devTools: !!isDev,
    },
  });

  // Avoid a white flash: only show once the renderer is ready to paint.
  win.once('ready-to-show', () => win.show());

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  return win;
}

module.exports = { createWindow };
