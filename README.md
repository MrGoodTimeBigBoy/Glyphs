# Glyphs

A cozy, curious keyboard playground for an early reader, in a CRT-terminal shell: phosphor green on black, warm and slow. See `DESIGN.md` for the why, `ROADMAP.md` for the build order.

The app is a hub plus four worlds. The hub is a terminal: type any word and the machine speaks it (720 pre-rendered words; unknown words get sounded out letter by letter; some words trigger hidden ASCII flourishes). Typing a keyword opens a world — ESC always comes home:

- **`find`** — letters fall toward ghosted slots spelling a word; catch them by key or click
- **`hide`** — a breathing wall of one letter hides an impostor; find it, or build your own wall and let the machine seek
- **`draw`** — a turtle canvas where every letter draws something; `p` for colors, `x` to clear
- **`say`** — Simon Says for spelling: the machine spells with glowing tiles and musical tones, you type it back

There are no scores, no levels, no failure states. Every letter has a fixed musical tone, the same in every world.

## Setup

Requires Node 22+ and npm.

```sh
npm install
```

Electron is the only dependency. The audio clips ship in the repo — no API keys or network needed to run the app (keys are only needed to *regenerate* clips; see `tools/tts/README.md`).

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

**What kiosk mode disables on macOS** (verified on hardware, June 2026): while Glyphs runs in prod, the presentation options requested by kiosk mode disable **Cmd+Tab**, **Mission Control**, **Spotlight (Cmd+Space)**, and **Force Quit (Cmd+Opt+Esc)**, along with the Dock and menu bar. Only Cmd+Q exits. In dev mode (windowed, non-kiosk) Cmd+Tab and Force Quit behave normally.

**What still gets through** (also verified on hardware):

- **Third-party global hotkeys.** Apps that register system-wide hotkeys fire over the kiosk — e.g. the ChatGPT desktop app's Option+Space launcher appears, and submitting it moves focus to ChatGPT. These events never reach Glyphs and cannot be intercepted. Quit such apps or disable their hotkeys before handing the machine over.
- **Universal Control.** Holding the pointer at a screen edge can slide it onto a nearby iPad or Mac. Disable it in System Settings → Displays → Advanced ("Allow your pointer and keyboard to move between any nearby Mac or iPad"), or keep other devices away.
- **The power button and the lid.**

Recovery note: because kiosk mode disables Force Quit, if the app ever hard-wedges the way out is holding the power button (or killing it over SSH). Cmd+Q is handled in the main process, so a renderer-side fault alone can't trap you.

Glyphs deliberately registers no system-wide shortcut grabs of its own. For harder lockdown (a child-dedicated macOS user account, Screen Time limits), that's OS configuration, not an app feature.

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
