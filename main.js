'use strict';

const { app } = require('electron');
const { createWindow } = require('./window');
const { installAppLevel, attachToWindow } = require('./containment');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');
// Phase 2: --audio-test loads the audio validation harness instead of the
// Phase 1 shell. It does not touch the cage; plain typing already passes through.
const isAudioTest = process.argv.includes('--audio-test');
const page = isAudioTest ? 'test-audio.html' : 'index.html';

// Catch unhandled exceptions: log and exit non-zero so CI notices.
process.on('uncaughtException', (err) => {
  process.stderr.write((err && err.stack ? err.stack : String(err)) + '\n');
  app.exit(1);
});

// Install app-level containment before the app is ready so that the
// web-contents-created listener is in place for the very first webContents.
installAppLevel({ isDev });

// Single-window kiosk: quit on all platforms when the window is closed.
// No macOS "linger with no windows" behaviour.
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  const win = createWindow({ isDev, page });
  attachToWindow(win, { isDev });

  if (isSmoke) {
    // Smoke mode: used for headless CI verification only.
    // Give the renderer 2 s to settle after load, then exit cleanly.
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => app.quit(), 2000);
    });

    win.webContents.once('did-fail-load', () => {
      app.exit(1);
    });
  }
});
