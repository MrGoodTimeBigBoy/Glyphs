# Glyphs — Phase 2 Plan (Audio validation harness)

This is the approved implementation plan for Phase 2. ROADMAP.md says *what*, DESIGN.md says
*why*, this file says *how*. The Phase 2 audit checks the code on disk against this document.

## Scope

Exactly the Phase 2 "Build" list in ROADMAP.md: a TTS generation script, a small validation
clip set (~20 words + 26 phonemic letter sounds + 26 letter names + "hmm"), a minimal in-shell
test page where typing a word plays the right thing, and a short audio-pipeline README. This
phase ends at a **manual listening gate**: Ian judges warmth, pacing, and the seam between
known-word playback and letter sounding-out. Phase 3 does not start until Ian signs off.

**Out of scope (must not appear):** the full 600–800 clip bundle; any UI beyond the minimal
test page; hub integration; CRT scanline/flicker; world logic; persistence. No changes to
`containment.js`. ESC stays unbound (reserved for future return-to-hub).

## Decisions resolved with Ian (the audit checks these were surfaced and resolved)

- **Provider / model:** Google **Gemini 3.1 Flash TTS Preview**, served **through OpenRouter**.
- **Generation path:** in-container, this session, via whichever container has the network
  access. **Requires from Ian:** `openrouter.ai` added to the environment's network allowlist
  **and** `OPENROUTER_API_KEY` set in the session env. (Verified at plan time: OpenRouter is
  governed by a host allowlist; OpenAI/ElevenLabs are likewise blocked; Google's own Gemini API
  host `generativelanguage.googleapis.com` is reachable as a documented fallback.)
- **Voice:** a **bake-off**. The full set renders in a primary voice (**Sulafat**, warm); a
  shared representative subset also renders in **Aoede** (breezy) and **Callirrhoe**
  (easy-going). The "expressive storyteller" delivery is a natural-language **style prompt**
  applied to every request. Ian picks the final voice by ear at the gate; re-rendering the full
  set in the chosen voice is then a one-command rerun.
- **DESIGN.md alignment:** DESIGN says "Google Wavenet **or similar**". Gemini Flash TTS is the
  "or similar / equivalent high-quality voice." This is recorded so the audit treats DESIGN's
  intent as satisfied rather than violated.
- **No browser-TTS fallback (hard rule):** unknown words use the pre-rendered "hmm" + per-letter
  clips only. `renderer/js/audio.js` must never reference `window.speechSynthesis`.

## Clip storage path + CSP

- **Storage** lives under the renderer so the sandboxed `file://` page can load it:

  ```
  renderer/audio/<voice>/words/<word>.wav
  renderer/audio/<voice>/letters-phonemic/<letter>.wav
  renderer/audio/<voice>/letters-name/<letter>.wav
  renderer/audio/<voice>/hmm.wav
  ```

  `<voice>` ∈ { `sulafat`, `aoede`, `callirrhoe` }. The primary voice (`sulafat`) carries the
  full set; the others carry the bake-off subset. The renderer falls back to the primary voice
  when a clip is absent in the current voice.

- **CSP:** add `media-src 'self'` to the existing `renderer/index.html` meta CSP (so Phase 3
  inherits it) and to the new `renderer/test-audio.html`. No other CSP change — `'self'`
  already resolves for `file://` resources (Phase 1's `style-src`/`script-src 'self'` prove it).

- **Format:** **WAV**. Gemini TTS returns L16/24 kHz mono PCM; the script wraps PCM → WAV using
  Python's stdlib `wave` module (the container has no `ffmpeg`, and none is needed). If
  OpenRouter returns an already-containerized format, the script writes it verbatim and records
  the extension in the manifest.

## The word list (20)

Sight words: `the and run mom dad see go like you me`
Common nouns: `cat dog sun moon tree star apple fish bird rain`

Covers every ROADMAP-named example (the, and, cat, run, mom, apple, tree, sun) and the DESIGN
decorated-word starters. Plus 26 phonemic letter sounds ("kuh" not "see"), 26 letter names, and
the "hmm" interjection.

Bake-off subset (rendered in all three voices): `cat sun apple the run`, phonemic `c a t`, and
`hmm`.

## File manifest

Every file below must exist at exactly this path with non-trivial content.

```
PHASE2-PLAN.md                          this file
tools/tts/generate_clips.py             generation script. Python 3 stdlib only (urllib, json,
                                        base64, wave, struct, os, argparse) — no pip installs,
                                        runs on macOS unchanged. Reads OPENROUTER_API_KEY.
                                        Configurable: model id, voice list, style prompt, output
                                        dir, word list. Holds the phonemic + letter-name spelling
                                        maps as data. Writes WAVs and renderer/audio/manifest.js.
tools/tts/wordlist.txt                  the 20 words, one per line (script default input)
tools/tts/README.md                     audio pipeline README: approach, model, voice chosen,
                                        how to generate more clips / change voice / re-render
renderer/audio/manifest.js              GENERATED: window.Glyphs.register-free data file that
                                        sets window.Glyphs.audio = { voices, primary, ext, words }
renderer/audio/<voice>/...              GENERATED clip tree (see storage path above)
renderer/test-audio.html                the harness page; CSP includes media-src 'self'; loads
                                        namespace → containment → pointer → manifest → audio →
                                        audio-test → boot
renderer/js/audio.js                    playback engine: known word → its clip; unknown all-alpha
                                        word → "hmm" then phonemic letter clips in sequence
                                        (chained on 'ended'); junk (non-alpha/empty) → nothing.
                                        Voice state + cycle; per-clip fallback to primary voice.
                                        Never uses window.speechSynthesis.
renderer/js/audio-test.js               harness UI: input buffer, on-screen input line + a small
                                        status/voice indicator, Enter submits, Backspace edits,
                                        Tab cycles voice. ESC untouched.
main.js                                 + parse --audio-test; pass page to createWindow
window.js                               + accept { page } param (default 'index.html')
package.json                            + "test-audio" and "gen-clips" scripts
renderer/index.html                     + media-src 'self' in the CSP meta
```

`renderer/index.html` otherwise stays the pristine Phase-1 shell (the future hub). The harness
is a separate page so headless `xvfb-run -a npm run dev -- --smoke --no-sandbox` keeps booting
`index.html` and exiting 0.

## Renderer contract

- `manifest.js` sets `window.Glyphs.audio = { voices: [...], primary: 'sulafat', ext: 'wav',
  words: [ ...known words... ] }`. It runs after `namespace.js`. (It does not need
  `register()` — it is plain data the engine reads.)
- `audio.js` registers via `window.Glyphs.register('audio', { init })` and exposes a small play
  API on the namespace (e.g. `window.Glyphs.audio.play(word)` / voice setters) for the harness.
- `audio-test.js` registers via `window.Glyphs.register('audioTest', { init })`.
- Boot order in `test-audio.html`: `namespace.js`, `containment.js`, `pointer.js`,
  `manifest.js`, `audio.js`, `audio-test.js`, `boot.js`.

## Generation contract (OpenRouter)

The exact Gemini-TTS model id and audio response shape on OpenRouter are **not hardcoded from
memory**. At the generation gate the script's model id is confirmed against
`GET /api/v1/models`, and one probe call confirms the response shape (audio field, encoding,
sample rate) before the full run. If OpenRouter does not actually return audio for the chosen
model, STOP and report — fallbacks are Gemini-direct (`generativelanguage.googleapis.com`,
verified reachable) or generating on Ian's Mac.

## Execution order (subagent dispatch)

1. **Chunk 0 (inline):** write this plan; set the /goal; commit.
2. **Chunk 1 (inline):** wiring — `main.js`, `window.js`, `package.json`, `index.html` CSP;
   create the `renderer/audio/` + `tools/tts/` skeleton.
3. **Chunk A — impl subagent (Sonnet):** `tools/tts/generate_clips.py`, `tools/tts/wordlist.txt`,
   `tools/tts/README.md`. Built now; run later at the gate. Disjoint from B.
4. **Chunk B — impl subagent (Sonnet):** renderer harness — `test-audio.html`, `js/audio.js`,
   `js/audio-test.js`. Runs in parallel with A.
5. **Review + commit (inline).**
6. **★ GATE (Ian):** `openrouter.ai` allowlisted + `OPENROUTER_API_KEY` set (may require a fresh
   web session for the container to pick up the change). Then probe + run generation; write the
   clip tree + `manifest.js`; commit.
7. **Chunk C — verification subagent (Haiku):** script ran; expected clip files exist and are
   non-empty; manifest matches files on disk; `xvfb-run -a npm run dev -- --smoke --no-sandbox`
   exits 0; the test page boots headless. Reports pass/fail with captured exit codes.
8. **Chunk D — audit subagent (Sonnet, fresh context):** reads DESIGN.md, ROADMAP.md Phase 2,
   this file; checks file manifest, scope (no creep), the no-browser-TTS rule, containment
   untouched, dev/prod + smoke intact, `window.Glyphs.*` consistency. Findings fixed; re-audit
   until clean.
9. **Handoff (inline):** Ian's listening checklist (the manual gate); push to
   `claude/glyphs-phase2-audio-6qwps3`.
