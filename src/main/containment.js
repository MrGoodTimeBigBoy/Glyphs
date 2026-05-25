const { app, Menu } = require('electron');

const FUNCTION_KEYS = new Set([
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);

// The single sanctioned exit: Cmd+Q on macOS, Ctrl+Q elsewhere.
function isQuitCombo(input) {
  if (input.key.toLowerCase() !== 'q') return false;
  return process.platform === 'darwin' ? input.meta : input.control;
}

function applyContainment(win, { dev }) {
  // Drop the application menu and every accelerator that rides on it.
  Menu.setApplicationMenu(null);

  const wc = win.webContents;

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
    if (input.control || input.meta || FUNCTION_KEYS.has(input.key)) {
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
