'use strict';

const { app, Menu } = require('electron');

/**
 * installAppLevel({ isDev })
 *
 * Call before (or around) app.whenReady(). Sets up containment that applies
 * to every webContents created during the app's lifetime.
 *
 * Null menu note: Menu.setApplicationMenu(null) removes the menu bar and all
 * default menu accelerators — including macOS's built-in Cmd+Q binding. That
 * is intentional: we re-implement quit manually in attachToWindow so it lives
 * entirely inside our input interceptor, which runs for every input event
 * regardless of menu state.
 */
function installAppLevel({ isDev } = {}) {
  Menu.setApplicationMenu(null);

  app.on('web-contents-created', (event, wc) => {
    // Block all popup / new-window requests unconditionally.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));

    // will-navigate does NOT fire for programmatic loadFile/loadURL calls, so
    // blocking it unconditionally here is safe and prevents any renderer-side
    // navigation (e.g. clicking an <a href="..."> that somehow appears later).
    wc.on('will-navigate', (e) => e.preventDefault());
  });
}

/**
 * attachToWindow(win, { isDev })
 *
 * Installs the before-input-event interceptor on win's webContents.
 * Decision tree (evaluated top-to-bottom, first match wins):
 *
 *  1. Quit chord  — always capture; fire app.quit() on keyDown only.
 *  2. Dev hatches — isDev only; handled programmatically (see note below).
 *  3. Any chord   — deny-all; swallows everything not already handled above.
 *  4. F1–F12      — deny regardless of modifiers (kills F11, F12, Alt+F4…).
 *  5. Everything else — pass through (plain typing must always reach the renderer).
 */
function attachToWindow(win, { isDev } = {}) {
  const darwin = process.platform === 'darwin';

  win.webContents.on('before-input-event', (event, input) => {
    // Normalize key once; input.key may be undefined for synthetic events.
    const key = (input.key || '').toLowerCase();

    // The "primary" modifier: Cmd on macOS, Ctrl elsewhere.
    const primary = darwin ? input.meta : input.control;

    // ── 1. Quit ──────────────────────────────────────────────────────────────
    // We own Cmd+Q / Ctrl+Q because Menu.setApplicationMenu(null) removed the
    // native binding. Always preventDefault so the renderer never sees it.
    if (primary && key === 'q' && !input.shift && !input.alt) {
      event.preventDefault();
      if (input.type === 'keyDown' && !input.isAutoRepeat) {
        app.quit();
      }
      return;
    }

    // ── 2. Dev hatches (dev mode only) ───────────────────────────────────────
    // The null application menu removed every native accelerator, so merely
    // letting these chords "pass through" would do nothing — reload and
    // DevTools have to be invoked programmatically here.
    if (isDev) {
      // Reload: primary+R or primary+shift+R
      if (primary && key === 'r' && !input.alt) {
        event.preventDefault();
        if (input.type === 'keyDown' && !input.isAutoRepeat) {
          win.webContents.reload();
        }
        return;
      }

      // DevTools: Cmd+Option+I (darwin) | Ctrl+Shift+I (others) | F12
      const devtoolsChord =
        (darwin && input.meta && input.alt && key === 'i') ||
        (!darwin && input.control && input.shift && key === 'i') ||
        key === 'f12';
      if (devtoolsChord) {
        event.preventDefault();
        if (input.type === 'keyDown' && !input.isAutoRepeat) {
          win.webContents.toggleDevTools();
        }
        return;
      }
    }

    // ── 3. Deny-all chords ───────────────────────────────────────────────────
    // Swallowing every unhandled chord is safer than enumerating
    // Cmd+W / Cmd+M / Cmd+H / Cmd+F / Ctrl+Alt+Del variants / zoom / etc.
    if (input.meta || input.control) {
      event.preventDefault();
      return;
    }

    // ── 4. Function keys (any modifiers) ────────────────────────────────────
    // Covers F11 fullscreen toggle, F12 DevTools, and Alt+F4 (arrives as F4).
    if (/^f([1-9]|1[0-2])$/.test(key)) {
      event.preventDefault();
      return;
    }

    // ── 5. Everything else passes ────────────────────────────────────────────
    // Plain letters, Shift+letters, arrows, Escape, Enter, etc.
    // "Every keypress produces some response" is a design principle — never
    // swallow plain input. Escape is intentionally NOT special-cased here.
  });
}

module.exports = { installAppLevel, attachToWindow };
