const { app } = require('electron');
const { createWindow } = require('./src/main/window');
const { applyContainment } = require('./src/main/containment');

const dev = !app.isPackaged || process.env.GLYPHS_DEV === '1';

// A second launch must never spawn a second cage over the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    const win = createWindow({ dev });
    applyContainment(win, { dev });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
