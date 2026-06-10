const { app } = require('electron');
const { createWindow } = require('./src/main/window');
const { applyContainment } = require('./src/main/containment');

const dev = !app.isPackaged || process.env.GLYPHS_DEV === '1';

// Trackpad two-finger swipe must not navigate history. Command-line
// switches have to be set before the app is ready.
app.commandLine.appendSwitch('disable-features', 'OverscrollHistoryNavigation');

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
