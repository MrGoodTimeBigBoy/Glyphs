# Glyphs — Roadmap

Build order, with a definition of done for each phase. Phases happen sequentially. The roadmap exists so that Claude Code sessions stay scoped: each session works on one phase, not “the app.” When in doubt about scope, the rule is *the current phase only*.

For design intent behind any of these, see `DESIGN.md`. The roadmap is what to build; the design doc is why.

-----

## Phase 1 — Electron shell and containment

Get a fullscreen Electron app running with all the lockdown behavior in place. No game content yet. Just a black screen with a blinking cursor — enough to prove the cage works.

**Build:**

- Electron project scaffold (`npm init`, `electron` as the only runtime dep)
- `main.js` configures a single BrowserWindow: fullscreen, kiosk mode, no resize, no minimize
- `preload.js` set up with `contextIsolation: true`
- `renderer/index.html` displays a black screen with a centered phosphor-green blinking cursor
- Dev tools disabled in production launch
- Right-click context menu disabled
- All standard browser shortcuts (Cmd+R, Cmd+W, Cmd+Shift+I, etc.) intercepted and swallowed
- Cmd+Q (macOS) and Ctrl+Q (other platforms) quit cleanly
- Cursor hides after 2s of no mouse movement, reappears on movement
- `npm start` launches the app

**Definition of done:**

- App launches fullscreen, presents a blinking cursor on a black screen
- Ian has tried to escape the app with every shortcut he can think of and only Cmd+Q works
- No menu bar, no dock interaction during runtime
- Cursor hide/show behavior verified

**Out of scope for this phase:**

- Any game logic
- Audio
- Typing input (the cursor blinks but doesn’t accept text yet — that’s Phase 3)
- State machine for worlds (just a static screen)

-----

## Phase 2 — Audio validation harness

Validate the audio pipeline before building anything that depends on it. This phase has a manual gate at the end: Ian listens and decides if the approach is good enough.

**Build:**

- A small TTS generation script (Python or Node, whatever’s easiest) that takes a list of words and produces audio clips using Google Cloud TTS Wavenet voices (or equivalent)
- Generate ~20 sample clips: a mix of common sight words (`the`, `and`, `cat`, `run`, `mom`) and common nouns (`apple`, `tree`, `sun`)
- Generate 26 letter-sound clips (the phonemic sound each letter makes, not the letter name — so `c` is “kuh” not “see”). The “letter name” version may also be useful; generate both and decide later which is the unknown-word fallback.
- Generate the “hmm” interjection
- A minimal test page (loaded in the Electron shell) where Ian can type a word and hear the result:
  - If the word is in the sample set, play the pre-rendered clip
  - If it’s not, play “hmm” followed by the letter sounds in sequence
- A short README documenting the TTS approach, voice chosen, and how to generate more clips

**Definition of done:**

- Ian has typed a dozen known and unknown words and listened to the output
- Ian judges that the warmth, pacing, and seam between known-words and letter-sounding are acceptable
- If the result is not acceptable: stop and reconsider before proceeding to Phase 3

**Out of scope for this phase:**

- The full word bundle (~600–800 clips). That’s a generation job for later; this phase just validates the approach.
- Any UI beyond a minimal typing test
- Integration into the hub (the hub doesn’t exist yet)

-----

## Phase 3 — The hub

The home screen. Typing, autocomplete, history, scrollback, decorated words. This is the heart of the app and the place Kieran will spend most of his time.

**Build:**

- A top-level state machine in the renderer with state `hub` (and stubs for `hide`, `draw`, `find` that we’ll fill in later phases)
- Hub screen:
  - Black background, phosphor green text
  - Blinking cursor on an input line near the bottom
  - History accumulates above the input line, scrolling slowly upward
  - Subtle CRT effects: slow scanline, gentle phosphor flicker
- Typing behavior:
  - Letters appear as he types
  - As he types, if his prefix matches a known keyword, the rest of the keyword appears ghosted in gray after the cursor
  - If multiple keywords match the prefix, the shortest one is ghosted and the alternatives appear in a list below the input line, browsable with arrow keys
  - Pressing Enter submits the word
- On submit:
  - If the word matches a keyword: transition to that world (stub for now — just show “would enter [keyword] world” and return to hub on ESC)
  - If the word is in the known-words audio set: play the clip, add to history
  - If the word is unknown but is alphabetic: play “hmm” then sound out the letters, add to history with a different visual treatment (italic? dimmer?) to mark it as unknown-but-spoken
  - If the word contains non-letters or is junk: small deflate sound, no history entry
- Decorated words: 8–12 words trigger a small ASCII flourish in addition to being spoken. Suggested starters in DESIGN.md.
- History/scrollback:
  - Up-arrow recalls the previous entry to the input line
  - Whole stack shifts down one row when an entry is recalled
  - Down-arrow puts the entry back, stack shifts back up
  - Up-arrow past the top of history halts with a tiny nudge
  - Typing any non-arrow key on a recalled entry turns it back into editable text
- Persistence: history is saved between sessions (use Electron’s `app.getPath('userData')` for storage)
- The full word audio bundle (~600–800 clips) is generated and bundled. This is the asset job referenced in Phase 2.

**Definition of done:**

- Kieran can type any word and the right thing happens (known word → spoken, unknown → sounded out, junk → deflate)
- Autocomplete reveals the keyword vocabulary as he types
- Decorated words produce their flourishes
- History persists across launches
- The whole experience feels warm and legible. Ian judges this by handing the app to Kieran and watching.

**Out of scope for this phase:**

- Any of the worlds (just stubs)
- Settings, profiles, parental controls

-----

## Phase 4 — `hide` world

Implement the hide world end to end, including the base game, hider mode, and speed rounds.

**Build:**

- `hide` world module conforming to the world interface (init/teardown, ESC returns to hub)
- Base game:
  - Field of one letter fills the screen, wrapping naturally
  - One impostor at a random position
  - Field gently breathes (slow wave animation)
  - After a few seconds the impostor begins to drift out of phase; drift accelerates over time
  - Find by clicking the impostor’s cell OR pressing the impostor’s key
  - On success: impostor grows, field scatters, machine says the impostor letter aloud, brief pause, new round
  - Difficulty progresses: distinct pairs first (n/h, o/c), similar pairs later (n/m, c/e)
  - Mashing absorbed (tiny visual pings)
- Hider mode:
  - Triggered by some action in the world (TBD — a key? a menu?)
  - Child types a wall of letters and hides one impostor (signal completion with Enter)
  - Machine theatrically searches: an eye-like cursor sweeps through the field, “hmm” sound, hovers near candidates, eventually finds the impostor
  - Machine always succeeds; better-hidden letters take longer
- Speed round:
  - Triggered periodically (frequency TBD during playtesting)
  - Churning field where impostors appear and disappear quickly, sometimes multiple at once

**Definition of done:**

- All three modes (base, hider, speed) work
- Ian and Kieran have played all three and the pacing feels right
- ESC always returns to the hub cleanly

-----

## Phase 5+ — Future

Not committed. Possible directions:

- `draw` world (turtle/Logo mode with color palette)
- `find` world (falling-letter sight-word catcher)
- Additional decorated words
- Pixel art replacing some ASCII flourishes
- A second child profile if this turns out to be useful

-----

## Working agreement with Claude Code

- Each Claude Code session is scoped to a single phase.
- Plan mode on before each phase. Ian reviews the plan before any code is written.
- DESIGN.md is the source of truth for *why*. The roadmap is the source of truth for *what now*. Conversation history is not authoritative.
- If during implementation a decision needs to be made that isn’t covered in DESIGN.md, ask. Don’t paper it over.
- The audio validation gate at the end of Phase 2 is real. Do not start Phase 3 if Ian hasn’t signed off on the audio.