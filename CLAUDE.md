# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Glyphs is

A fullscreen Electron "keyboard playground" for one specific kindergartener. CRT-terminal aesthetic: phosphor green on black, monospace, slow and warm. Typing letters and words makes things happen. See `DESIGN.md` for the full vision.

## Commands

- `npm start` — launch the **locked production build**: fullscreen kiosk, devtools off, all shortcuts swallowed except the quit combo. This is what you hand to a tester.
- `npm run dev` — launch a **windowed dev build**: normal frame, resizable, devtools open, shortcuts left intact. Use this while developing.
- The dev/prod split is driven by `dev = !app.isPackaged || process.env.GLYPHS_DEV === '1'` in `main.js`, threaded into `createWindow({ dev })` and `applyContainment(win, { dev })`. There is no separate config file — `dev` is the one switch.

There is no test runner, linter, or build step yet. `electron` is the only dependency.

### Headless smoke test (this cloud container only)

The app can't be rendered or interaction-tested in a headless container, but you can confirm it boots without throwing. Running as root requires `--no-sandbox` (an environment workaround — **do not** add it to app code):

```
timeout --preserve-status 8 xvfb-run -a -s "-screen 0 1280x800x24" npx electron --no-sandbox . 2>&1
```

Exit code 143 (killed by timeout after a clean run) = pass. A real exit with an error code = something threw. The interactive Definition of Done in `ROADMAP.md` can only be verified by a human on the target MacBook.

## How this project is built: phase discipline (read this first)

This is the most important operating constraint. **Each Claude Code session is scoped to exactly one phase of `ROADMAP.md`.** When in doubt about scope, the rule is *the current phase only* — do not build ahead into future phases, even if it seems convenient.

- **`ROADMAP.md` is the source of truth for *what to build now*** (sequential phases, each with a Definition of Done and an explicit "out of scope" list).
- **`DESIGN.md` is the source of truth for *why*** (design philosophy, world specs, cut features). Conversation history is **not** authoritative — defer to these two docs.
- **Plan mode before each phase.** The human reviews the plan before any code is written.
- **If a decision comes up that `DESIGN.md` doesn't cover, ask.** Don't paper over it.
- **The Phase 2 audio gate is real.** Do not start Phase 3 until the human has signed off on the audio approach by ear.

Phase 1 (Electron shell + containment) is complete. Phases 2+ (audio harness, hub, worlds) are not yet built.

## Architecture

### Two-process "cage / screen" model

The codebase deliberately splits responsibility, and **containment is layered across both processes with no overlap** — when changing lockdown behavior, change it in the layer that owns it:

- **Main process = window/OS-level cage.** `main.js` is a thin orchestrator (lifecycle, single-instance lock, dev flag). `src/main/window.js` builds the kiosk `BrowserWindow` with the secure `webPreferences` (`contextIsolation`, `sandbox`, `nodeIntegration:false`). `src/main/containment.js` nulls the app menu and uses `webContents.on('before-input-event')` to swallow every Cmd/Ctrl combo and the function keys, blocks navigation/popups, and keeps devtools shut in production.
- **Renderer = DOM-level screen.** `renderer/js/containment.js` handles only what the DOM owns (right-click menu, drag/drop, text selection). The cursor-hide-on-idle behavior lives in `renderer/js/cursor-idle.js`.

### The single sanctioned exit

Because the app menu is removed (`Menu.setApplicationMenu(null)`), the default Cmd+Q accelerator is gone. The quit combo is therefore **re-implemented by hand** in `containment.js` (`isQuitCombo`): Cmd+Q on macOS, Ctrl+Q elsewhere. If you touch shortcut handling, preserve this — it's the only way out of the kiosk.

### Renderer module pattern (no bundler)

Renderer scripts are plain `<script>` tags that attach to a `window.Glyphs.*` namespace; `renderer/js/main.js` is the entry point that calls each module's `init()` on DOMContentLoaded. There is intentionally **no bundler and no ES-module imports** — ESM over `file://` hits Chromium CORS restrictions. Add new renderer modules the same way (IIFE → `window.Glyphs.<name>`). Introducing a build step is deferred to Phase 3, when the renderer state machine arrives.

### Visual conventions

The phosphor palette and terminal metrics are CSS variables in `renderer/styles/base.css` (`--phosphor`, `--bg`, `--font-mono`, etc.). Reuse them rather than hardcoding colors; later phases depend on a consistent look.

## Design constraints that shape code (from DESIGN.md)

These are implementation rules, not just flavor — future phases must honor them:

- **No failure states.** No game-over, no red X, no "try again." A wrong input does nothing, something small, or doesn't register.
- **Mashing is absorbed, never punished.** Every keypress in every state produces *some* response (even a tiny ping), so the machine always feels alive.
- **No scores, levels, or progress bars.** Difficulty drifts gently within a world and resets when the child returns.
- **ESC always returns to the hub** (single press). Inside worlds the unit is the *letter*; words have power only in the hub.
- **Unknown words are sounded out letter-by-letter** — there is deliberately no browser-TTS fallback.
