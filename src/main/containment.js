const { app, Menu } = require('electron');

const FUNCTION_KEYS = new Set([
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

// The single sanctioned exit: bare Cmd+Q on macOS, bare Ctrl+Q elsewhere.
// Any extra modifier (Shift/Alt, or the wrong platform modifier) disqualifies
// it, so "only Cmd+Q quits" stays literally true.
function isQuitCombo(input) {
  if (input.key.toLowerCase() !== 'q') return false;
  if (input.alt || input.shift) return false;
  return process.platform === 'darwin'
    ? input.meta && !input.control
    : input.control && !input.meta;
}

function applyContainment(win, { dev }) {
  // Drop the application menu and every accelerator that rides on it.
  Menu.setApplicationMenu(null);

  const wc = win.webContents;

  // Pinch / gesture zoom isn't a key event, so before-input-event can't catch
  // it; clamp the zoom range so a child can't rescale the kiosk.
  wc.setVisualZoomLevelLimits(1, 1);

  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;

    if (isQuitCombo(input)) {
      event.preventDefault();
      app.quit();
      return;
    }

    // Dev leaves shortcuts intact so reload and devtools stay usable.
    if (dev) return;

    // Swallow every modifier combo and the function keys. Plain keys
    // (letters, arrows, ESC) pass through for later phases to handle.
    if (input.control || input.meta || input.alt || FUNCTION_KEYS.has(input.key)) {
      event.preventDefault();
    }
  });

  // Backstop in case devtools opens by any other route in production.
  if (!dev) {
    wc.on('devtools-opened', () => wc.closeDevTools());
  }

  // No wandering off the page, no popups or extra windows.
  wc.on('will-navigate', (event) => event.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
}

module.exports = { applyContainment };
