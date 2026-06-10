# Glyphs

A cozy, curious keyboard playground for an early reader, in a CRT-terminal shell: phosphor green on black, warm and slow. See `DESIGN.md` for the why, `ROADMAP.md` for the build order. This is Phase 1: the Electron shell and its containment — a black screen, a blinking cursor, and a cage that works.

## Setup

Requires Node 22+ and npm.

```sh
npm install
```

Electron is the only dependency.

## Running

```sh
npm start      # production: fullscreen kiosk, fully locked down
npm run dev    # development: windowed 1280×800, dev hatches enabled
```

**`npm start` (prod)** launches fullscreen in kiosk mode: no menu bar, no dock, no resize/minimize, DevTools hard-disabled, right-click dead, and every Cmd/Ctrl keyboard chord swallowed. **Cmd+Q (macOS) / Ctrl+Q (elsewhere) is the only exit.** The mouse pointer hides after 2 seconds idle and reappears on movement.

**`npm run dev`** keeps the full cage except: the window is a normal resizable window, and two hatches work — Cmd+R / Ctrl+R reloads, and Cmd+Opt+I (macOS) / Ctrl+Shift+I / F12 toggles DevTools. Note these hatches are implemented inside the app's input interceptor: the application menu is removed in both modes, so no native accelerators exist anywhere.

A `--smoke` flag (`npm run dev -- --smoke`) auto-quits ~2s after the renderer loads; it exists only for headless CI verification (e.g. under `xvfb-run`, with `--no-sandbox` inside containers).

## Containment: what's caught, and the macOS-level caveats

Everything that reaches the app is contained: browser shortcuts (Cmd+R, Cmd+W, Cmd+Shift+I, Cmd+M, Cmd+H, Cmd+F, Cmd+P, zoom…) are swallowed deny-by-default with Cmd+Q as the single allowlisted exit; F1–F12 are swallowed; navigation and popup windows are blocked; right-click, drag/drop, and text selection are dead at the DOM level.

Some escapes live **above the app** at the OS level and cannot be intercepted by any application:

- **Cmd+Tab** — the macOS app switcher still switches apps.
- **Mission Control** — Ctrl+Up, F3-as-media-key, and three/four-finger trackpad swipes still work.
- **Cmd+Opt+Esc** — Force Quit always works (and is the recovery path if the app ever wedges).
- **Cmd+Space** — Spotlight still opens over the app.
- The power button, Touch ID, and notification-center edge swipes are untouched.

These are accepted, documented limitations — Glyphs deliberately does not register system-wide shortcut grabs. If harder lockdown is ever needed, use a dedicated macOS user account for the child and/or Screen Time app limits; that's an OS configuration concern, not an app feature.

## Architecture: the containment layers

- **Main process owns the OS surface** — `window.js` (kiosk window config), `containment.js` (null application menu, `before-input-event` chord interception, quit handling, navigation/popup lockdown, DevTools policy).
- **Renderer owns the DOM surface** — `renderer/js/containment.js` (context menu, drag/drop), `renderer/js/pointer.js` (pointer auto-hide). CSS owns selection suppression.

Each behavior has exactly one owner. The renderer registers no keyboard handlers; the main process touches nothing DOM-side.

## Adding renderer modules (the `window.Glyphs.*` pattern)

The renderer is sandboxed (contextIsolation on, no Node) and uses plain classic scripts — no bundler, no ES modules. Every module registers itself on the shared namespace:

```js
// renderer/js/sparkle.js
window.Glyphs.register('sparkle', {
  init: function () {
    // wire up listeners, build DOM, etc.
  },
});
```

Then add it to `renderer/index.html` **after** `namespace.js` and **before** `boot.js`:

```html
<script src="js/namespace.js"></script>
<script src="js/containment.js"></script>
<script src="js/pointer.js"></script>
<script src="js/sparkle.js"></script>   <!-- new module here -->
<script src="js/boot.js"></script>
```

`boot.js` calls every registered module's `init()` in registration order once the DOM is ready. Anything that needs main-process powers goes through `preload.js` via `contextBridge` (currently exposes only a frozen `window.GlyphsHost.platform`).
