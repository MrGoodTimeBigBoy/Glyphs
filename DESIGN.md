# Glyphs — Design

A cozy, curious keyboard playground for an early reader.

## What this is

Glyphs is a fullscreen Electron app built for one specific kindergartener. It's a place where typing letters and words makes things happen — sometimes small things, sometimes whole little worlds. The aesthetic is CRT terminal: phosphor green on black, monospace everywhere, slow and warm. The lineage is Apple II BASIC and the text-MUD era, when computers felt like responsive places rather than tools.

It is not an educational app in the way that phrase is usually meant. It teaches by being interesting to poke at, not by quizzing or rewarding completion. There are no scores, no levels to unlock, no badges. The reward for engaging with Glyphs is that Glyphs does specific, legible, slightly delightful things in response to your input.

## Design philosophy

**Cozy and curious, not chaotic and rewarding.** The temptation with a kids app is to make every interaction maximally stimulating — explosions, fanfare, dopamine on tap. Glyphs goes the other direction. Responses are specific, proportional, and *learnable*. The machine doesn't reward you for engaging; it just notices you, and the noticing is enough.

**Every key has a personality.** Across the app, letters should feel like distinct things, not interchangeable inputs. A child who plays Glyphs for a week should be able to tell you something about what `s` does, what `r` does, what happens when you hold shift. This is the legibility principle: the machine is consistent and specific, and consistency is what lets a kid form a real relationship with it.

**No failure states.** Glyphs has no losing. No game-over screens, no red X marks, no "try again." A wrong input either does nothing, does something small and amusing, or just doesn't register. The machine is patient. The child sets the pace.

**Reading by exposure, not by drill.** The machine reads aloud, sounds out unknown words letter by letter, and decorates certain words with small flourishes. None of this is framed as practice. It's just what the machine does. Reading happens as a side effect of play.

**The machine has a voice but isn't a character.** Glyphs talks — it reads words aloud, it announces things — but it doesn't have a face, a name, or a personality in the chatbot sense. It's more like a friendly room than a friendly creature. Scripted dialogue trees were considered and rejected as a trap: either you build a real conversational agent (out of scope) or you ship something thin that a child sees through immediately.

## The hub

The home screen is the soul of the app. It is a mostly-empty terminal: black background, phosphor green text, blinking cursor on an input line near the bottom. Above the cursor, a history of words the child has typed scrolls slowly upward as new ones are added.

### Typing in the hub

Three kinds of input get three kinds of response:

1. **A keyword** (`hide`, `draw`, `find`, and similar): opens a world. The screen transitions and the child enters a different mode of play. ESC always returns to the hub.

2. **A real word** that the machine knows how to say: the machine pronounces it. The word appears in the history. Certain decorated words also trigger a small visual flourish (an ASCII cat walks across the bottom, a sun rises and sets, etc.) — these are not announced or listed; the child discovers them.

3. **A word the machine doesn't know**: the machine says "hmm" and sounds out the letters one at a time. C-A-T. This is the unknown-word path; there is no fallback synth voice. Phonics-as-feature, not robot TTS as a stopgap.

### Autocomplete

As the child types, if the prefix matches a keyword, the rest of the keyword appears ghosted in gray. If multiple keywords match, the shortest matching keyword is ghosted and the alternatives appear in a small list below the input line. Arrow keys browse the list. This is the discovery mechanism for the vocabulary of worlds — the child learns what's possible by starting to type things.

### History and scrollback

Typed entries persist on screen and accumulate over time. Up-arrow recalls the previous entry to the input line; the whole stack shifts down one row to make room. Down-arrow puts it back. Up-arrow past the top of history halts with a tiny nudge rather than cycling. Typing any non-arrow key on a recalled entry turns it back into editable text.

History persists between sessions. The hub on day three is not the same hub as day one; it has accumulated. Scrolling up becomes a small time machine of vocabulary growth.

### Visual treatment

The active input line has the blinking cursor. Recalled and historical entries are dimmer or slightly different in color, so the child can tell at a glance which line is "live." The hub gently breathes — a very slow scanline pass, a subtle phosphor flicker. It should feel alive but not busy.

## Audio

### Strategy

Most words the child types will be drawn from a known set: kindergarten and first-grade sight words, common nouns (animals, family, colors, foods, weather, household objects), and morphological variations (cat/cats, run/running/ran). These are **pre-rendered TTS clips** using a high-quality voice (Google Wavenet or similar). Estimated 600–800 clips, ~20–25MB bundled with the app.

Unknown words **do not** fall back to browser TTS. Instead, the machine says "hmm" and sounds out the letters individually using pre-rendered letter sounds. This is more useful for an early reader than hearing a synthesized voice mangle pronunciation, and it preserves the warmth of the known-words case.

### Validation gate

The audio approach is the project's biggest unknown. Before building the hub, the audio pipeline must be validated: a small harness generates ~20 sample words and the letter sounds, plays them in context, and the result is judged by ear. If the warmth isn't there, the strategy gets rethought before the rest of the app gets built on top of it.

### Decorated words

A small set of words (8–12 for v1) trigger ASCII or pixel-art flourishes in addition to being read aloud. These are not advertised. The child finds them by typing. Suggested starters: `cat`, `dog`, `sun`, `moon`, `tree`, `star`, `rain`, `fish`, `bird`, `mom`, `dad`. The decorated word set is meant to grow — adding new ones is an easy ongoing project, not a one-time scope decision.

## Worlds

### `hide`

The child's own invention. A field of one letter fills the screen — wall of text, wrapping naturally, edge to edge. One impostor letter lives somewhere in the field.

Find it by clicking or by pressing the impostor's key. Mashing produces tiny visual pings but never breaks state.

The field gently breathes — a slow wave animation. After a few seconds, the impostor begins to drift out of phase with the rest of the wall. The drift accelerates over time, so finding the impostor gets easier the longer the child looks. This is the hint system: it's just time. No explicit help is ever offered.

When found, the impostor grows, the rest of the field scatters or fades, the machine says the impostor letter aloud, and a new round begins.

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

When all slots are filled, the word animates (it pulses, glows, or briefly transforms into its decorated-word art if it has one), and a new word begins.

**Difficulty progression.** Start with two-letter words, expand to three and four. Reuse sight words and decorated words from the hub vocabulary so the worlds reinforce each other. Distractor letters (letters not in the current word) appear in later levels; pressing their keys does nothing or produces a tiny dud sound.

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
- **Browser TTS fallback for unknown words.** Letter sounding-out is better pedagogy and a warmer experience.
- **Pixel art assets in v1.** ASCII handles everything for v1. Pixel art is a possible later direction.
- **Settings menu, parent controls, profiles.** One child, one machine, one experience.
- **Real Logo grammar in `draw`.** Too much vocabulary for a kindergartener. Letter-by-letter associative response wins.
- **Word-based interactions inside worlds.** Inside worlds, the unit is the letter. Words live in the hub.

## Open questions

These should not block initial build but are worth holding in mind:

- **Exact difficulty curves** for hide drift, find speed/density, and color hidden-tier mechanics. Will be tuned by playtesting with Kieran.
- **Decorated word set for v1.** A starting list exists but the final selection is a creative decision worth time.
- **Hider mode interaction details.** How does the child signal "I'm done hiding"? Press enter? The interaction needs prototyping.
- **Speed round trigger logic.** Every N rounds? Random chance? Worth thinking about pacing.
- **Pre-rendered TTS voice choice.** Multiple high-quality TTS providers exist. Pick one, generate samples, evaluate before committing to the asset bundle.