# Glyphs

A cozy, curious keyboard playground for an early reader.

Glyphs is a fullscreen Electron app built for one specific kindergartener — a kid who loves letters, words, and counting to absurd numbers. It looks and feels like an old CRT terminal: phosphor green on black, monospace everywhere, a slow scanline, a blinking cursor. The lineage is Apple II BASIC, when computers felt like responsive places rather than tools.

It's not an educational app in the usual sense. There are no lessons, no quizzes, no badges. It teaches by being interesting to poke at: the machine notices everything you type and answers with something specific, legible, and slightly delightful. Reading happens as a side effect of play.

A few rules hold everywhere:

- **No failure states.** No losing, no game over, no red X. A wrong input does something small and kind, or quietly nothing.
- **No scores, levels, or progress bars.** Difficulty drifts gently and invisibly while you play, and resets when you come back.
- **Every key answers.** Mashing is absorbed, never punished — the machine always feels alive.
- **Every letter has a fixed musical tone**, the same in every corner of the app. Type enough and words start to sound like little melodies.
- **ESC always goes home.** One press, from anywhere.

`DESIGN.md` has the full design philosophy; `ROADMAP.md` the build history.

## Two modes: `speak` and `spell`

The whole app lives in one of two modes, switched by typing the mode's name in the hub. **`speak`** (the default) is phonics and phosphor green: words are pronounced. **`spell`** is a spelling bee and turns the entire CRT amber: every word is spelled aloud by letter name ("cat" → "see ay tee"), and words the machine knows are pronounced *after* the spelling — spell it, then hear it. Switching is announced by the app's only double-utterance: enter spell mode and the machine spells "SPELL"; enter speak mode and it pronounces "SPEAK" by its phonemes. The mode sticks between sessions.

## The hub

You land in a terminal with a blinking cursor. Type any word and press Enter:

- A word the machine knows (720 of them — sight words, animals, food, weather, feelings, numbers up to the trillions) is **spoken aloud** in a warm, recorded voice and added to a scrolling history that persists between sessions.
- A word it doesn't know gets a thoughtful "hmm…" and is **sounded out by its true phonemes** — `shop` is /sh/ /o/ /p/, not s-h-o-p. Behind the hmm, a three-tier pipeline (CMU dictionary → eSpeak NG → an on-device language model) works out the pronunciation of anything, including made-up words. Phonics as a feature, not a fallback. (In spell mode, the spelling *is* the answer.)
- Junk input gets a small friendly *pfff*.
- A handful of words trigger **hidden ASCII flourishes** — a cat walks across the screen, a sun rises. They're not listed anywhere; you find them by typing.

Start typing a world's name and the rest appears ghosted — that's the autocomplete, and it's how the vocabulary of worlds (and the two modes) gets discovered.

## The worlds

### `find` — the arcade beat

Letters fall from the top of the screen toward ghosted slots that spell a target word. When a falling letter nears the catch line, press its key (or click it) and it flies into its slot with a satisfying thunk and its musical tone. Fill the word and it glows, plays its flourish if it has one, and the machine says it aloud. Missed letters just fall away and come again; catching a letter you already have earns a bonus chime. Words quietly grow from two letters to four, and stray distractor letters sneak in later — pressing one just fizzles.

### `hide` — one of these letters is not like the others

A wall of one letter fills the screen, gently breathing. Somewhere in it hides a single impostor — an `m` in a field of `n`s. Find it by pressing its key or clicking it. The hint system is simply time: the longer you look, the more the impostor drifts out of rhythm with the wall. Rounds climb from easy pairs (`n`/`h`) to evil ones (`o`/`e`). Every few rounds the field erupts into a churning speed round. And if you press the wall's own letter four times, the game flips: now *you* build the wall, hide your own impostor, and watch the machine's eye sweep theatrically across the screen — humming, hovering, always finding it in the end. Hide it well and the search takes longer.

### `draw` — a turtle with the alphabet for a paintbox

A small ASCII turtle sits on a canvas, and every letter makes it do something: `c` draws a circle, `s` a spiral, `l` a line, `r` turns right, `b` makes the turtle bigger, `y` grows a branching tree, digits draw shapes with that many sides, arrows steer. There's nothing to memorize — mashing produces drawings. `p` opens a color palette (a few colors are hidden), Shift+R turns the trail into a rainbow, `x` wipes the canvas with a phosphor sweep. Click to hop the turtle somewhere; drag to draw by hand. Your picture is still there if you leave and come back.

### `say` — Simon Says for spelling

The machine spells a word at you: large glowing tiles light up one by one, each playing its letter's musical tone. Then it's your turn to type it back. Each correct letter echoes its glow and tone; a wrong key gets a soft sigh and the word starts over — never lost, just spelled again. Complete it and the whole word glows while the machine pronounces it (or, in spell mode, spells it back by letter name — the bee runs on its own rules). Words climb from `a` and `i` through longer and longer spellings, then cycle back around a little quicker each time. Because every letter always plays the same tone, familiar words become familiar tunes — you start to *hear* spelling.

## Setup

Requires Node 22+ and npm.

```sh
npm install
```

Runtime dependencies: `electron` and `espeak-ng` (a WASM port used by the unknown-word phoneme pipeline — no system binary needed). The audio clips ship in the repo — no API keys or network needed to run the app (keys are only needed to *regenerate* clips; see `tools/tts/README.md`).

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

`boot.js` calls every registered module's `init()` in registration order once the DOM is ready. Anything that needs main-process powers goes through `preload.js` via `contextBridge` — the frozen `window.GlyphsHost` surface: `platform`, `loadHistory()`/`saveHistory()`, `loadMode()`/`saveMode()`, and `g2p(word)` (the grapheme-to-phoneme pipeline; see `g2p/README.md`).

## Audio assets and pipelines

Speech is pre-rendered TTS, committed to the repo (the app is fully offline at runtime). See `tools/tts/README.md` for generation, verification, and the ear-tuning workflow; `g2p/README.md` for the unknown-word phoneme pipeline.

```sh
npm run gen-clips        # generate any missing clips (needs API key — env or Keychain)
npm run verify-clips     # check the clip tree against the manifest and format contract
npm run test-g2p         # exercise all three G2P tiers (CMU → eSpeak NG → fm)
npm run test-phonemes    # render concatenated phoneme words for A/B listening
```
