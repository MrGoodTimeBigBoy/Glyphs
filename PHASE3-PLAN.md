# Glyphs — Phase 3 Plan (The hub + full word audio bundle)

This is the implementation plan for Phase 3. ROADMAP.md says *what*, DESIGN.md says *why*,
this file says *how*. The Phase 3 audit checks the code on disk against this document.

## Scope

Exactly the Phase 3 "Build" list in ROADMAP.md:

- A top-level renderer state machine — state `hub`, plus stubs for `hide` / `draw` / `find`
  ("would enter [keyword] world", ESC returns to hub).
- The hub screen: black/phosphor-green, blinking cursor on an input line near the bottom,
  history accumulating above, subtle CRT scanline + phosphor flicker.
- Typing, keyword autocomplete (ghost + alternatives list), Enter submits.
- Submit behavior: keyword → world stub; known word → clip + history; unknown all-alpha →
  "hmm" + letter sound-out + dimmed/italic history entry; junk → small deflate sound, no
  history entry.
- Decorated words: the 11 DESIGN.md starters trigger small ASCII flourishes.
- History/scrollback: up-arrow recall, stack shift, top-of-history nudge, edit-on-keypress.
- Persistence across launches via `app.getPath('userData')`.
- **The full word audio bundle** (~600–800 clips) generated with the Phase 2 pipeline.

**Out of scope (must not appear):** the real `hide`/`draw`/`find` worlds; settings, profiles,
parental controls; pixel art; any reference to `window.speechSynthesis` (hard rule, forever).
No changes to `containment.js` (main) or `renderer/js/containment.js`. The Phase 2 harness
(`test-audio.html`, `audio-test.js`) stays as-is for ear checks.

## Decisions resolved with Ian (2026-06-10, this session)

- **Bundle word list:** Claude curates ~650–750 words; **Ian reviews the committed list
  before the generation run** (checkpoint ★ below).
- **Delivery hints:** new words get **category-level** hints (animals lively, weather gentle,
  celestial hushed, food cheerful, action energetic, function words plain, …). The 11
  decorated words keep/receive **individually tuned** hints matched to their flourish
  character (per gate feedback). Existing gate-approved clips are not re-rendered unless a
  hint deliberately changes.
- **Decorated set:** all 11 DESIGN starters — `cat dog sun moon tree star rain fish bird mom dad`.
- **Comparison voices:** sulafat/aoede **kept** at bake-off-subset size through Phase 3
  (Tab A/B in the harness stays useful while delivery is iterated). They never render the
  new bundle words — subsets stay frozen at the Phase 2 size.

## Part A — the word audio bundle

### A1. Word list curation (★ Ian review checkpoint)

Target ~650–750 words, assembled from:

- **Sight words:** Dolch pre-primer → first grade, Fry first 300.
- **DESIGN.md noun categories:** animals, family, colors, foods, weather, body, household
  objects, nature, numbers one–ten.
- **Morphological variants** of high-frequency words: cat/cats, run/running/ran,
  big/bigger/biggest, etc.

`tools/tts/wordlist.txt` keeps its one-entry-per-line, append-only contract; the existing
20 validation words stay at the top. The format gains an **optional second column**:
`word [category]` (whitespace-separated; the generator takes token 0 as the word, token 1
as the delivery category; no category → plain storyteller read). One file stays the single
reviewable source of truth — no parallel category file to drift.

**Checkpoint ★:** the curated list is committed and Ian reviews/edits it (skim for words he
doesn't want, missing favorites) before any API spend. Generation starts only after his OK.

### A2. Generator changes (`tools/tts/generate_clips.py`)

- Parse the two-column wordlist format (manifest words = token 0, order preserved).
- New `CATEGORY_STYLES` dict (~8 short hints, written in the voice of the gate-accepted
  ones). Hint resolution: `WORD_STYLES[word]` (individual override) → `CATEGORY_STYLES[cat]`
  → plain. `WORD_STYLES` keeps the gate-accepted entries; decorated-word hints get tuned
  there to match each flourish.
- New **`deflate` interjection** (ROADMAP: junk input → "small deflate sound"): a soft,
  breathy "pfff" generated through the same pipeline as `hmm`, stored at
  `renderer/audio/<voice>/deflate.wav`, primary voice (+ bake-off voices, like hmm), listed
  in the manifest. Stdlib-only constraint unchanged.
- Everything else (quoted target word, PCM→WAV, tail conditioning, idempotent skip,
  retries) is untouched — the README's hard-won OpenRouter contract is not re-litigated.

### A3. Generation run

1. Confirm `OPENROUTER_API_KEY` present and `--list-models` shows the model routable.
   If not: STOP and report (Gemini fallback needs `GEMINI_API_KEY`, which is not set).
2. `--probe` first (per pipeline discipline).
3. Full run in the **background** (~1 h at Phase 2 pace; ~700 new clips; cost trivial).
   Idempotent, so interruptions just mean re-running.
4. Re-render only deliberately changed clips (`--force` is never used globally).

### A4. Verification (`tools/tts/verify_clips.py`, NEW — committed this time)

Phase 2 ran this as an ad-hoc script; Phase 3 commits it. Exit 0 only if:

- Every wordlist/letter/interjection clip exists for the primary voice and is non-empty;
  bake-off subsets complete for sulafat/aoede.
- Every WAV is 24 kHz / mono / 16-bit.
- Durations within 0.2–6 s (catches the empty-audio and read-the-instructions failure modes).
- Tails actually silent (last 80 ms RMS ≈ 0 — catches missing tail conditioning).
- `manifest.js` matches the files on disk and wordlist order; no orphan clips.

### A5. Listening spot-check protocol (Ian can't audit ~700 clips by ear)

- Sent to Ian **as files**: the new `deflate` clip, every decorated-word clip whose hint
  changed, plus a **random stratified sample of ~30 bundle words** (3–4 per category).
- The automated checks in A4 cover existence/format/duration/tails for the rest.
- The harness (`npm run test-audio`) remains the tool for ear-driven iteration; any word
  Ian dislikes is a one-line hint edit + single-word re-render.

## Part B — the hub

### New/changed files

```
renderer/js/state.js      top-level state machine: 'hub' | 'hide' | 'draw' | 'find'.
                          Worlds register {enter, exit}; stubs render "would enter X
                          world". ESC: in a world → return to hub; in the hub → nothing.
                          ESC listening lives HERE, not in containment.js (untouched).
renderer/js/hub.js        hub UI: input line + block cursor, history rendering,
                          autocomplete (ghost + alternatives list), arrow-key
                          recall/scrollback, Enter submit dispatch.
renderer/js/crt.js        scanline pass + phosphor flicker. CSS-animation driven,
                          GPU-cheap, very subtle (DESIGN: "alive but not busy").
renderer/js/flourish.js   decorated-word ASCII flourishes (11), one active at a time,
                          requestAnimationFrame, never blocks typing.
renderer/js/persist.js    history load/save through the preload bridge; debounced saves.
preload.js                + GlyphsHost.loadHistory() / saveHistory(entries) via
                          ipcRenderer.invoke (contextIsolation stays true).
main.js                   + ipcMain.handle('glyphs:history-load'/'glyphs:history-save')
                          → JSON at userData/history.json, atomic write (tmp+rename).
renderer/index.html       becomes the hub page. Script order: namespace → containment →
                          pointer → audio/manifest → audio → state → crt → flourish →
                          persist → hub → boot. CSP unchanged.
renderer/styles.css       + hub styles (input line, history dimming, ghost gray,
                          alternatives list, CRT overlay, flourish layer).
```

`audio.js` gains one small addition: `play()` returns `{type:'junk'}` as today **and** the
hub plays the `deflate` clip on junk (clip lookup added beside `hmm`). No other changes.

### Interaction specifics (filling gaps in ROADMAP's text — Ian: flag anything wrong)

- **Keywords:** exactly `hide`, `draw`, `find`.
- **Autocomplete:** ghost completes the **shortest** keyword matching the typed prefix;
  if several match, alternatives appear in a small dim list below the input line.
  **Arrow-key precedence:** while the alternatives list is visible, ↑/↓ browse the list;
  otherwise ↑/↓ do history recall. Enter accepts ghost/selection; typing keeps filtering.
- **Unknown-word history treatment:** dimmer + italic (ROADMAP's suggestion), letters
  highlight in sync with the sound-out (reusing the harness's `onLetter` hook).
- **Junk** (non-alpha or empty): deflate clip, brief cursor wiggle, no history entry.
- **History:** newest at the bottom, scrolls upward; persisted entries capped at 500
  (bounds the file; "day three hub" intact). Stored shape: `{word, type, ts}`.
- **Recall editing:** any non-arrow key on a recalled entry converts it to live editable
  text (per DESIGN). Up past the top: 2-frame nudge animation, stays put.
- **Flourish sketches** (small, 1–3 s, bottom strip unless noted): cat walks across;
  dog bounds with a tail wag; sun rises top-right and sets; moon arcs with two stars;
  tree grows from a sprout; star twinkles center-top; rain falls in a short column;
  fish swims with bubbles; bird flies across the top; mom/dad each pulse a small heart
  beside the word. Flourishes never interrupt audio or typing.

### Containment & validation invariants

- `containment.js` (both) byte-identical to main.
- `xvfb-run -a npm run dev -- --smoke --no-sandbox` exits 0 (hub boots headless; no
  autoplay at boot, so no audio-policy issues).
- `npm run test-audio` harness unchanged and still functional with the grown manifest.

## Execution order (subagent dispatch)

1. **Chunk 0 (inline):** commit this plan.
2. **Chunk 1 (inline):** curate the word list (+categories); commit. **★ Ian reviews the
   list (AskUserQuestion with the list summary + file pushed) before generation.**
3. **Chunk 2 — impl subagent:** generator changes (A2). Disjoint from Chunk 3.
4. **Chunk 3 — impl subagent:** renderer hub (Part B), run in parallel with 2.
5. **Chunk 4 (inline, after ★):** probe → full background generation → `verify_clips.py`
   → commit clips + manifest.
6. **Chunk 5 — verification subagent:** A4 script green; smoke green; harness boots;
   manifest/disk/wordlist consistency.
7. **Chunk 6 — audit subagent (fresh context):** reads DESIGN.md, ROADMAP.md Phase 3, this
   file; checks scope, containment untouched, no speechSynthesis, `window.Glyphs.*`
   consistency. Findings fixed; re-audit until clean.
8. **Handoff (inline):** spot-check files to Ian (A5); push `claude/glyphs-phase3-hub-mmq5x3`.

## Definition of done (ROADMAP, restated)

Known word → spoken; unknown → sounded out; junk → deflate; autocomplete reveals the
keywords; decorated words flourish; history persists across launches; Ian hands it to
Kieran and watches. The final judgment is Ian's, by feel, with Kieran.
