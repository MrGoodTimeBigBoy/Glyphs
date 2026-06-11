# Glyphs — Design

A cozy, curious keyboard playground for an early reader.

## What this is

Glyphs is a fullscreen Electron app built for one specific kindergartener. It's a place where typing letters and words makes things happen — sometimes small things, sometimes whole little worlds. The aesthetic is CRT terminal: phosphor green on black, monospace everywhere, slow and warm. The lineage is Apple II BASIC and the text-MUD era, when computers felt like responsive places rather than tools.

It is not an educational app in the way that phrase is usually meant. It teaches by being interesting to poke at, not by quizzing or rewarding completion. There are no scores, no levels to unlock, no badges. The reward for engaging with Glyphs is that Glyphs does specific, legible, slightly delightful things in response to your input.

## Design philosophy

**Cozy and curious, not chaotic and rewarding.** The temptation with a kids app is to make every interaction maximally stimulating — explosions, fanfare, dopamine on tap. Glyphs goes the other direction. Responses are specific, proportional, and *learnable*. The machine doesn't reward you for engaging; it just notices you, and the noticing is enough.

**Every key has a personality.** Across the app, letters should feel like distinct things, not interchangeable inputs. A child who plays Glyphs for a week should be able to tell you something about what `s` does, what `r` does, what happens when you hold shift. This is the legibility principle: the machine is consistent and specific, and consistency is what lets a kid form a real relationship with it.

A letter's musical **tone** is its body — fixed, mode-independent, the same note whether the app is green or amber. The voice (a phoneme or a letter name) is its **costume**, dressing the body differently in speak and spell modes. The distinction matters: tones carry across both modes without contradiction, while the voice is an honest signal of which way the machine is approaching the word right now.

**No failure states.** Glyphs has no losing. No game-over screens, no red X marks, no "try again." A wrong input either does nothing, does something small and amusing, or just doesn't register. The machine is patient. The child sets the pace.

**Reading by exposure, not by drill.** The machine reads aloud, resolves unknown words to their true phonemes, and decorates certain words with small flourishes. None of this is framed as practice. It's just what the machine does. Reading happens as a side effect of play.

**The machine has a voice but isn't a character.** Glyphs talks — it reads words aloud, it announces things — but it doesn't have a face, a name, or a personality in the chatbot sense. It's more like a friendly room than a friendly creature. Scripted dialogue trees were considered and rejected as a trap: either you build a real conversational agent (out of scope) or you ship something thin that a child sees through immediately.

## Speak and spell modes

The app has two global modes. Mode is set from the hub with first-class keywords, persisted across launches in `userData/mode.json`, and defaults to `speak`.

**Speak mode** is phonics. The CRT glows phosphor green — the default, the baseline. Known words play their pre-rendered word clip. Unknown words get the machine's honest attempt at the real pronunciation, via the G2P pipeline described in the Audio section.

**Spell mode** is the spelling bee. The CRT turns amber — same machine, same scanlines, same cursor, second costume. Every typed word is spelled aloud by letter name: `cat` comes out "see ay tee." Known words then get the word clip played after the spelling (spell it, then hear it — the bee structure). Unknown words: the spelling stands alone, because letter names are always true of the word, and that's enough.

### Typing the mode keywords

`speak` and `spell` live in the autocomplete vocabulary alongside the world keywords. Typing either one fully shows a preview: the live text in the input line switches to that mode's bright color before you press Enter — phosphor green for `speak`, amber for `spell` — so the child can see where they're headed before committing.

Pressing Enter switches mode with a short whole-app color ease (the `mode-flux` transition, ~600 ms). Then comes the app's only deliberate double-utterance, and it is not flourish — it's pedagogy. Entering spell, the machine spells "SPELL" by letter names. Entering speak, it pronounces "SPEAK" by phonemes (S P IY K). The keyword names the mode; the machine's delivery demonstrates what that mode sounds like. One announcement, one demonstration, immediate.

Typing the keyword you are already in is a recognized no-op. Nothing announces, nothing changes — the word doesn't stand out in the input line or the history. The machine acknowledges with its near-silent tick (the mashing-is-absorbed convention: every keypress produces *some* response) and that's all. It has heard you; it already knows.

### Color identity

All colors flow through a mode-keyed palette of CSS custom properties (`--ph-bright`, `--ph-mid`, `--ph-dim`, `--ph-faint`, `--ph-ghost`, `--ph-bright-rgb`, and so on) set on `body.mode-speak` and `body.mode-spell`. The amber ramp is brightness-matched to the green one so the two modes feel like peers rather than default and exception. Mode-independent bright values (`--ph-speak-bright`, `--ph-spell-bright`) are always defined at `:root` so the target-mode preview can use them regardless of which mode is active.

The `draw` world's rainbow trail palette stays literal — real colors, not phosphor identity — but its default trail color and wipe flash follow the mode.

## The hub

The home screen is the soul of the app. It is a mostly-empty terminal: black background, phosphor green text, blinking cursor on an input line near the bottom. Above the cursor, a history of words the child has typed scrolls slowly upward as new ones are added.

### Typing in the hub

Four kinds of input get four kinds of response:

1. **A mode keyword** (`speak` or `spell`): switches the global mode, plays the double-utterance announcement, no history entry. Already in that mode: a recognized no-op — just the near-silent tick.

2. **A world keyword** (`hide`, `draw`, `find`, `say`): opens a world. The screen transitions and the child enters a different mode of play. ESC always returns to the hub.

3. **A real word** that the machine knows how to say: in speak mode the machine pronounces it; in spell mode the machine spells it by letter names and then pronounces it (bee structure). The word appears in the history. Certain decorated words also trigger a small visual flourish (an ASCII cat walks across the bottom, a sun rises and sets, etc.) — these are not announced or listed; the child discovers them. Decorated-word flourishes are visual and mode-independent.

4. **A word the machine doesn't know**: in speak mode, the machine says "hmm" and resolves the word to its true ARPABET phonemes via the G2P pipeline, then plays them one by one from the phoneme clip library. In spell mode, the machine spells it by letter names. There is no fallback synth voice, in either mode. The old behavior — sounding out unknown words grapheme by grapheme — was wrong phonics: `shop` came out /s//h//o//p/ instead of /ʃ//ɒ//p/. The phoneme path corrects that.

Input that isn't a word at all — empty, or containing non-letters — gets the soft deflate sound and a cursor wiggle, and leaves no history entry. Not a failure state; a small amused shrug.

### Autocomplete

As the child types, if the prefix matches a keyword, the rest of the keyword appears ghosted in gray. If multiple keywords match, the shortest matching keyword is ghosted and the alternatives appear in a small list below the input line. Arrow keys browse the list. This is the discovery mechanism for the vocabulary of worlds — the child learns what's possible by starting to type things.

### History and scrollback

Typed entries persist on screen and accumulate over time. Up-arrow recalls the previous entry to the input line; the whole stack shifts down one row to make room. Down-arrow puts it back. Up-arrow past the top of history halts with a tiny nudge rather than cycling. Typing any non-arrow key on a recalled entry turns it back into editable text.

History persists between sessions. The hub on day three is not the same hub as day one; it has accumulated. Scrolling up becomes a small time machine of vocabulary growth.

### Visual treatment

The active input line has the blinking cursor. Recalled and historical entries are dimmer or slightly different in color, so the child can tell at a glance which line is "live." The hub gently breathes — a very slow scanline pass, a subtle phosphor flicker. It should feel alive but not busy.

## Audio

### Strategy

Most words the child types will be drawn from a known set: kindergarten and first-grade sight words, common nouns (animals, family, colors, foods, weather, household objects), and morphological variations (cat/cats, run/running/ran). These are **pre-rendered TTS clips** using the Gemini Flash TTS pipeline, `callirrhoe` voice — 720 words plus the letter sets and interjections, WAV throughout; conversion to a compressed format is an easy later win.

Unknown words **do not** fall back to browser TTS. Instead, the machine says "hmm" and resolves the word to its true phonemes using the G2P pipeline, then plays those phonemes from the pre-rendered phoneme library. In spell mode, it spells by letter names. Either way the child hears the same warm voice — no robot, no synthesis engine speaking live.

### G2P: the three-tier pipeline

When the hub encounters an unknown word in speak mode, it starts two things concurrently: the `hmm` clip, and a G2P (grapheme-to-phoneme) request via IPC to the main process. The hmm covers latency; phoneme playback begins once both are ready.

The pipeline in `g2p/index.js` runs three tiers, each producing a complete ARPABET phoneme sequence:

1. **CMU Pronouncing Dictionary** — bundled at `g2p/cmudict.dict`. Instant; covers the large majority of English words.
2. **eSpeak NG WASM** — a bundled npm package; no install, no network, near-instant. Converts IPA output to ARPABET via a static mapping table. Agrees with CMU on about 90% of common words; handles inflections, compound words, and less-common vocabulary the dict doesn't carry.
3. **`fm` CLI (Apple Foundation Models)** — the macOS `fm` command, an on-device LLM constrained by a JSON schema enumerating only the 39 valid ARPABET symbols. Takes roughly 10 seconds. This is the long tail: made-up words, proper nouns, nonsense strings. The hmm plus a beat of thinking silence covers the wait.

If every tier fails, the fallback is `spellWord` — letter names are always true of the word, so the child still hears something honest.

The pipeline never streams partial results: all three tiers produce a complete phoneme sequence or nothing, so streaming would buy nothing. Developer affordances: `GLYPHS_PHONICS_TIER=cmu|espeak|llm` forces a single tier; `GLYPHS_LOG_TIER=1` logs per-word tier resolution to stderr.

### Audio libraries

Three pre-rendered clip libraries live under `renderer/audio/callirrhoe/`:

- **`words/`** — the full word bundle (720 words). Plays verbatim for known words in both modes.
- **`letters-name/`** — 26 letter-name clips ("ay", "bee", "see" …). Used everywhere a letter name is needed: spell mode in the hub, `hide`'s found-impostor announcement in spell mode, `say`'s completion in spell mode, and the mode-announcement for entering spell ("SPELL" spelled by letter names).
- **`phonemes/`** — 39 ARPABET clips, one per phoneme symbol. Plays when the G2P pipeline resolves an unknown word in speak mode, and to announce entering speak mode ("SPEAK" as S P IY K). These clips are optimised for concatenation: after the standard tail conditioning, each clip gets energy-threshold silence trimming, 5/25 ms fades to eliminate splice clicks, and RMS normalisation to a common target so no phoneme jumps out of a sequence. Per-phoneme-class playback gaps replace the flat letter gap: stops 30 ms, affricates 40 ms, vowels 60 ms, other continuants 50 ms. The constants (`PHONEME_ENERGY_THRESHOLD`, `PHONEME_FADE_IN_MS`, `PHONEME_FADE_OUT_MS`, `PHONEME_RMS_TARGET`) are in `generate_clips.py` and labelled ear-tuning candidates.

The `letters-phonemic/` set (26 clips, one phonemic sound per letter) remains in the bundle for any direct playback needs but is no longer the unknown-word fallback.

**Not yet rendered:** as of the speak/spell commit, the tooling for the phoneme library is complete but the 39 clips have not been generated — that requires the API key. Run `npm run gen-clips -- --primary-only`. The `tools/tts/test_phonemes.py` script concatenates CMU-known words from the new clips and lets you A/B them against the pre-rendered word clips by ear. Concatenated playback won't match co-articulated speech, but intelligibility is the bar, and the constants above are the knobs.

### Validation gate

The audio approach was validated before building the hub: a small harness generated ~20 sample words and the letter sounds, played them in context, and Ian judged the result by ear. Passed 2026-06-10. Voice: Gemini TTS, `callirrhoe`. The sulafat/aoede comparison subsets remain frozen in the bundle until the bake-off is formally closed.

### Decorated words

A small set of words (8–12 for v1) trigger ASCII or pixel-art flourishes in addition to being read aloud. These are not advertised. The child finds them by typing. Suggested starters: `cat`, `dog`, `sun`, `moon`, `tree`, `star`, `rain`, `fish`, `bird`, `mom`, `dad`. The decorated word set is meant to grow — adding new ones is an easy ongoing project, not a one-time scope decision.

### Letter tones

Every letter has a fixed musical tone, assigned once and used consistently across the entire app. The same tone for `c` plays when the child presses `c` in `draw`, when `say` spells a word containing `c`, and when `find` locks a caught `c` into its slot. This is the concrete implementation of the "every key has a personality" principle from the design philosophy — tone is part of what makes each letter a *distinct thing* rather than an interchangeable input.

A tone is the letter's **body**: constant, mode-independent, the same pitch whether the CRT is green or amber. The voice (phoneme or letter name) is the letter's **costume**, changing with the mode. The body and the costume are independent; the tone always rings true regardless of which mode the machine is in.

Tones are drawn from a major scale spanning a couple of octaves, one pitch per letter. The five vowels (A, E, I, O, U) sit at chord-tone scale degrees — root, third, fifth — so they ring with a clarity that stands them apart from the consonants. Words thereby become small melodies; the melodic pattern of a familiar word becomes another route to recognizing it.

This is a small synth engine, not a pre-rendered asset — a few oscillators via the Web Audio API, held in a single shared module.

## Worlds

### `hide`

The child's own invention. A field of one letter fills the screen — wall of text, wrapping naturally, edge to edge. One impostor letter lives somewhere in the field.

Find it by clicking or by pressing the impostor's key. Mashing produces tiny visual pings but never breaks state.

The field gently breathes — a slow wave animation. After a few seconds, the impostor begins to drift out of phase with the rest of the wall. The drift accelerates over time, so finding the impostor gets easier the longer the child looks. This is the hint system: it's just time. No explicit help is ever offered.

When found, the impostor grows, the rest of the field scatters or fades, the machine says the impostor letter aloud, and a new round begins. The announcement respects the global mode: in speak mode the machine plays the letter's phonemic sound clip; in spell mode it plays the letter's name.

Difficulty is the field/impostor pairing. Visually distinct pairs first (`n`/`h`, `o`/`c`), similar pairs later (`n`/`m`, `o`/`e`, `c`/`e`). Drift starts at about 5 seconds and lengthens as rounds progress.

**Hider mode.** A variant in which the child types a wall of letters and hides one impostor, then the machine searches. The machine theatrically scans — an eye-like cursor sweeps through likely areas, makes a "hmm" sound, hovers, eventually finds the impostor. The machine always succeeds. Pacing is the feedback: better-hidden letters take longer.

**Speed round.** Triggered periodically. A moving, churning field of a base letter (like `w`) with impostors (`v`, `m`, `n`) appearing and disappearing quickly, sometimes more than one at once, sometimes duplicates. The breathing field becomes a chaotic field. Same shape vocabulary, different game.

### `draw`

A turtle on a canvas. Every letter does something visual. The mappings are associative where possible: `c` draws a circle, `s` a spiral, `l` a line forward, `r` turns right, `b` makes the turtle bigger, `space` moves without drawing. The child doesn't have to memorize anything — every press makes something happen, and mashing produces drawings.

The turtle is visible and slightly charming (small ASCII or pixel turtle). Trails are softer than the turtle so the turtle stands out.

**Color.** Starts phosphor green. A small green square in the bottom corner indicates current color. Pressing `p` opens a palette overlay: colored squares with letters inside (`R` red, `O` orange, `Y` yellow, `G` green, `B` blue, `I` indigo, `V` violet, plus hidden `C` cyan, `M` magenta, `W` white). Press a color's letter, the palette closes, the indicator changes color, the turtle's trail uses the new color. Shift+R activates rainbow mode — trail cycles through colors as the turtle moves.

**Reserved keys in `draw`:** `p` (palette), `x` (clear screen), ESC (exit to hub). The reserved set must stay small; every reserved key is one fewer key for play.

**No word handling.** Inside `draw`, letters are letters, not words. Words have power in the hub; inside worlds, letters are the unit.

### `find`

The arcade beat. Letters fall from the top of the screen. Near the bottom are fixed slots showing the target word as faintly-ghosted letters — the child sees what to catch.

When a falling letter crosses the catch line, pressing its key locks it into its slot with a satisfying sound. The order is random: letters don't fall in word order, and any letter can fall at any time. Missing a letter has no penalty — it just falls off the screen, and the same letter will come again.

Catching a letter that's already locked produces a bonus chime. This means getting the same letter multiple times is rewarded, not punished.

When all slots are filled, the word animates (it pulses, glows, or briefly transforms into its decorated-word art if it has one), the word clip plays, and a new word begins.

`find` is **deliberately mode-agnostic.** Its unit is the sub-word letter, where the phoneme/letter-name distinction doesn't really apply. Each caught letter plays its musical **tone** — the letter's body, not its voice — and the completion word clip is identical in both modes. The world has a consistent musical identity regardless of whether the app is green or amber.

**Difficulty progression.** Start with two-letter words, expand to three and four. Reuse sight words and decorated words from the hub vocabulary so the worlds reinforce each other. Distractor letters (letters not in the current word) appear in later levels; pressing their keys does nothing or produces a tiny dud sound.

### `say`

Simon Says for spelling. The machine spells a word at the child: each letter glows in sequence, large across the screen, and plays its musical tone. Then it's his turn — he types the word back, one letter at a time. Each correctly typed letter glows again and plays its tone, a quiet echo confirming the sequence is rebuilding. A wrong key plays a soft buzz and resets the sequence to the first letter of the current word — not a loss, just start that word again.

When all letters are in, the full word glows brightly, and the machine celebrates. In speak mode it pronounces the word aloud using the same pre-rendered clip the hub uses. In spell mode it spells the word by letter names — the bee structure commits here — and deliberately never plays the word clip; the spelling is the celebration. A new word appears after.

**The musical layer.** Every letter has a consistent musical tone, assigned once and used everywhere (see Audio — Letter tones). During the show phase, the machine spells words as small melodies; during the input phase, typing each letter replays its tone. The musical consistency is what makes `say` work: a sufficiently engaged player starts to *hear* spelling — the melody of `cat` becomes as familiar as its shape.

**Visual treatment.** The word displays as large glowing letters across the screen with generous spacing between them. During the show phase, letters glow in sequence and then dim. During the input phase, letters remain dim until correctly typed, lighting up one by one with their tones. On completion the full word glows brightly before clearing for the next.

**Progression.** Words begin at one letter (`a`, `i`) and climb: two-letter sight words (`it`, `on`, `to`, `my`, `we`), then three-letter CVC words (`cat`, `dog`, `sun`), extending through the full curated list. When the cycle tops out it resets — each pass is a *wave*, each wave showing the words at a slightly faster pace. Only the show phase accelerates; input pacing stays comfortable throughout. No game over, no score.

**Word source.** A curated subset of the same audio bundle the hub uses. Phonetically regular CVC words come first; sight words with irregular spellings layer in as the child grows comfortable with the mechanic. Every word in `say` is a word the hub can speak.

**Reserved keys.** ESC returns to the hub. That's it. During the show phase, key presses produce at most a tiny visual ping — they don't interrupt the show or advance the sequence. During the input phase, the wrong key triggers the buzz and restart; the right key advances the sequence.

## Cross-world conventions

- **ESC** always returns to the hub. Single press, no hold or combo.
- **Cmd+Q** (macOS) is the only OS-level shortcut that passes through. Everything else is captured by the app.
- **Mashing is absorbed, never punished.** Every keypress in every state produces *some* response — even if it's just a tiny visual ping or a near-silent click — so the machine always feels alive.
- **No score, no levels, no progress bars.** Difficulty drifts gently within a world based on continued engagement, and resets when the child returns.
- **The mouse works everywhere it makes sense.** Click targets are huge and forgiving.

## Containment

This runs on a MacBook with a kindergartener at the controls. Containment matters.

- Fullscreen kiosk mode on launch.
- No menu bar, no dock, no minimize/resize.
- Dev tools disabled.
- Right-click context menu disabled.
- All standard browser shortcuts captured.
- Cursor hides after 2s of no movement, reappears on movement.
- Cmd+Q is the only legitimate exit.

## What's not in scope

The following were considered and explicitly cut:

- **A `hi` keyword for conversation.** Scripted dialogue is too thin and real conversation requires an LLM, which is out of scope for cost and complexity reasons.
- **Browser TTS fallback for unknown words.** Phoneme sounding-out is better pedagogy and a warmer experience. The phoneme clips are the same warm voice as the word clips; there is no robot TTS anywhere in the experience.
- **Pixel art assets in v1.** ASCII handles everything for v1. Pixel art is a possible later direction.
- **Settings menu, parent controls, profiles.** One child, one machine, one experience.
- **Real Logo grammar in `draw`.** Too much vocabulary for a kindergartener. Letter-by-letter associative response wins.
- **Word-based interactions inside worlds.** Inside worlds, the unit is the letter. Words live in the hub.
  (`find` and `say` put a word on screen as the target, but the input unit is still the letter — the rule bars hub-style word *entry* inside worlds, and stands.)

## Open questions

These should not block initial build but are worth holding in mind:

- **Exact difficulty curves** for hide drift, find speed/density, say show pacing, and color hidden-tier mechanics. First-pass values are shipped in the worlds; tuning by playtesting with Kieran is the live question.
- **Decorated word set for v1.** *Resolved:* all 11 starters shipped. Still meant to grow.
- **Hider mode interaction details.** *Resolved in implementation:* pressing the wall's own letter four times flips into hider mode; Enter (or a 3.5s pause once an impostor is planted) hands the wall to the machine.
- **Speed round trigger logic.** *Resolved in implementation:* every 4–6 found impostors, re-randomized each time.
- **Pre-rendered TTS voice choice.** *Resolved:* Gemini TTS, `callirrhoe`, chosen by ear through the Phase 2 listening gate. The sulafat/aoede comparison subsets stay frozen in the bundle until the bake-off is formally closed.
- **The buzz in `say`.** The wrong-key buzz-and-reset is the closest Glyphs comes to a punishing mechanic. It's built kind (a low sigh, gentle dim-out, the word never lost) — whether it *feels* kind is a playtesting question.