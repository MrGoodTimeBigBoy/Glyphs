# Glyphs — TTS Audio Pipeline

## Approach

Glyphs uses **pre-rendered TTS clips** generated offline with **Google Gemini
Flash TTS** via the [OpenRouter](https://openrouter.ai/) API (plan of record),
with Google's Gemini API direct as a documented fallback. All audio is bundled
with the app as plain WAV files under `renderer/audio/`.

### Why no browser TTS fallback?

This is a deliberate design decision documented in `DESIGN.md`:

> Unknown words **do not** fall back to browser TTS. Instead, the machine says
> "hmm" and sounds out the letters individually using pre-rendered letter
> sounds. This is more useful for an early reader than hearing a synthesized
> voice mangle pronunciation, and it preserves the warmth of the known-words
> case.

Every word the machine knows, it speaks warmly. Words it doesn't know, it
sounds out letter by letter from the same pre-rendered letter clips. There is
no robot TTS voice anywhere in the experience.

---

## Model and voices

| Role | Value |
|------|-------|
| **API (plan of record)** | OpenRouter — `POST https://openrouter.ai/api/v1/audio/speech` |
| **Model** | `google/gemini-3.1-flash-tts-preview` (provider: Google Vertex; verified live 2026-06-10) |
| **Key** | `OPENROUTER_API_KEY` |
| **Primary voice** | **Callirrhoe** — chose at the 2026-06-10 listening gate; full word set + all letters (phonemic and name) + hmm + deflate |
| **Comparison voices** | **Sulafat**, **Aoede** — bake-off subset kept for A/B while delivery is iterated |
| **Output format** | WAV / PCM 24 kHz mono, 16-bit signed little-endian, tail-conditioned (see below) |

### The OpenRouter TTS contract (hard-won, verified 2026-06-10)

Three non-obvious facts, so nobody re-burns a session rediscovering them:

1. **TTS models are hidden from `GET /api/v1/models`.** Their output modality
   is `"speech"`, and the public list omits them entirely. Confirm a TTS model
   via `GET /api/v1/models/{id}/endpoints` (or `--list-models` here, which
   does exactly that).
2. **`chat/completions` cannot serve them.** Requests with
   `modalities: ["text","audio"]` are rejected at routing ("No endpoints found
   that support the requested output modalities") and plain text requests are
   rejected by the provider. The dedicated endpoint is
   **`POST /api/v1/audio/speech`** with the OpenAI-TTS-shaped body
   `{model, input, voice, response_format}`.
3. **`response_format` accepts only `"mp3"` or `"pcm"`.** The script requests
   PCM; the response is raw bytes with the framing in the Content-Type header
   (`audio/pcm;rate=24000;channels=1`), which the script parses and wraps into
   WAV with the stdlib `wave` module.

### Gemini-direct fallback (`--api gemini`)

Should the OpenRouter route disappear, the same script speaks Google's Gemini
API directly: `POST {base}/v1beta/models/{model}:generateContent` with
`responseModalities: ["AUDIO"]` and a `prebuiltVoiceConfig` voice; audio
returns as base64 L16 PCM in `candidates[0].content.parts[*].inlineData`.
Same voices, same output. Needs `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) —
https://aistudio.google.com/apikey — and the default model id
(`gemini-2.5-flash-preview-tts`) confirmed via `--api gemini --list-models`.
`generativelanguage.googleapis.com` is reachable from the container
environment.

### Style prompt and per-word delivery

Every word clip uses the storyteller base style:

> "Read this aloud in a clear, warm, friendly voice, like a gentle storyteller
> reading to a young child. *(optional per-word hint)* Natural and unhurried:
> "*word*""

Delivery hints come from two dicts in `generate_clips.py`, resolved in this
order for each word:

1. **`WORD_STYLES[word]`** — an individually tuned hint (gate feedback was
   that one uniform delivery across all twenty words felt repetitive, and
   e.g. the animals wanted to be more active). Always wins.
2. **`CATEGORY_STYLES[category]`** — a category-level hint selected by the
   word's optional category column in `wordlist.txt` (Phase 3 bundle:
   action, animal, body, celestial, color, family, feeling, food, home,
   magic, nature, number, place, vehicle, weather — one short sentence
   each, written in the voice of the gate-accepted per-word hints).
3. Neither → the plain storyteller read.

To iterate on a delivery: edit the hint, then
`python3 tools/tts/generate_clips.py --voices callirrhoe --force` (or
delete just that word's WAV and re-run without `--force`).

**The target word stays in double quotes.** This is load-bearing, not
cosmetic: with a bare word after the colon, the model returned *empty audio*
for short function words ("and", "go", "me", …) and read the instruction
itself aloud for ~20 seconds for "the". Quoting fixed every case (verified
2026-06-10).

Phonemic letter clips use a separate prompt that instructs the model to produce
only the **phonetic sound** (not the letter name). The spellings are data in
`PHONEMIC_MAP` — e.g. "r" is spelled `rrr` because `rr` rendered as "ooo"
(gate feedback). Wrong-sounding letters are fixed by adjusting the spelling
there and re-rendering.

### Interjections (hmm, deflate)

Two non-word clips live directly under each voice directory (no `words/`
subdirectory), generated through the same pipeline with their own prompts:

- **`hmm.wav`** (`PROMPT_HMM`) — the soft, thoughtful "hmm" that prefixes
  the letter sound-out for unknown words.
- **`deflate.wav`** (`PROMPT_DEFLATE`, Phase 3) — a soft, breathy,
  deflating "pfff" played when the child types junk. DESIGN.md says there
  are no failure states, so it must sound gentle and amused, never harsh.

Both render for the primary voice and the bake-off voices. The renderer
hardcodes their paths; they are not listed in the manifest's `words`.

### Voice line-up (bake-off resolved)

The 2026-06-10 listening gate picked **Callirrhoe** as the primary voice.
Sulafat and Aoede remain in the tree at bake-off-subset size so the harness
can still A/B warmth while delivery is iterated:

- Words: `cat sun apple the run`
- Phonemic letters: `c a t`
- hmm, deflate

Once delivery is settled they can be dropped entirely (delete their
directories and remove them from `BAKEOFF_VOICES`, then re-run to refresh the
manifest).

---

## Prerequisites

1. **Python 3** — standard library only, no `pip install` required.
2. **An OpenRouter API key** (get one at
   https://openrouter.ai/settings/keys), provided either way:
   - `OPENROUTER_API_KEY` environment variable, or
   - the **macOS Keychain** (preferred — nothing secret ever sits in the
     repo tree, so nothing can leak into a public repo). Store it once:

     ```sh
     security add-generic-password -a "$USER" -s OPENROUTER_API_KEY \
         -w 'sk-or-v1-…' -U
     ```

     The generator checks the environment first, then the Keychain
     (service name = env var name). Same scheme works for
     `GEMINI_API_KEY` on the fallback route.
3. **Network access to `openrouter.ai`** at generation time (clips are
   generated once and committed; the app itself is fully offline).

---

## Commands

### Step 1 — probe (always run this first on a new machine)

```sh
export OPENROUTER_API_KEY=sk-or-v1-...
python3 tools/tts/generate_clips.py --probe
```

This generates exactly **one clip** (the word "cat", primary voice), prints
the response Content-Type and detected audio format, and writes the clip to
`renderer/audio/callirrhoe/words/cat.wav`. Inspect the output to confirm:

- The model ID is accepted (no "model not found" error).
- Audio bytes come back (the probe prints size, framing, and duration).
- The written WAV file plays correctly.

To check the model is still routable, or to hunt for a successor id:

```sh
python3 tools/tts/generate_clips.py --list-models
python3 tools/tts/generate_clips.py --api gemini --list-models   # fallback route
```

### Step 2 — full run

```sh
python3 tools/tts/generate_clips.py
```

Or via npm:

```sh
npm run gen-clips
```

This generates all clips for all voices (primary Callirrhoe full set +
Sulafat/Aoede comparison subsets) and writes `renderer/audio/manifest.js`.

### Other useful invocations

```sh
# Re-generate everything for one voice (overwrite existing) — the usual
# move after editing WORD_STYLES or PHONEMIC_MAP:
python3 tools/tts/generate_clips.py --voices callirrhoe --force

# Primary voice only (skip bake-off voices):
python3 tools/tts/generate_clips.py --primary-only

# Use a specific model ID (e.g. after confirming via --list-models):
python3 tools/tts/generate_clips.py --model google/some-newer-tts-model

# Generate from a custom word list:
python3 tools/tts/generate_clips.py --words path/to/mywords.txt

# Write clips to a different directory (e.g. a throwaway probe):
python3 tools/tts/generate_clips.py --probe --out /tmp/audio-test

# The Gemini-direct fallback (needs GEMINI_API_KEY):
python3 tools/tts/generate_clips.py --api gemini --probe
```

---

## The word list format

`tools/tts/wordlist.txt` is the single source of truth for the word bundle.
One entry per line, whitespace-separated, **append-only**:

```
# Lines starting with # and blank lines are ignored (section headers OK).
the                # no category → plain storyteller read
bear animal        # category → CATEGORY_STYLES["animal"] delivery hint
```

Token 0 is the word (file order = manifest order); the optional token 1
names a `CATEGORY_STYLES` delivery category. A word's `WORD_STYLES` entry,
if present, overrides its category hint either way.

## Adding more words

1. Add the new word(s) to `tools/tts/wordlist.txt` (format above).
2. Run the generator — it is **idempotent**: existing clips are skipped
   automatically. Only the new words are fetched from the API.

```sh
echo "rainbow color" >> tools/tts/wordlist.txt
python3 tools/tts/generate_clips.py --primary-only
```

The manifest is rewritten after each run to reflect what was actually produced.

---

## Verifying the clip tree

`tools/tts/verify_clips.py` (stdlib only, like the generator) checks the
generated tree against the word list and the format contract:

```sh
python3 tools/tts/verify_clips.py          # full check
npm run verify-clips                       # same thing
python3 tools/tts/verify_clips.py --quick  # skip the duration/tail scan
```

It verifies that every expected clip exists and is non-empty (primary
voice: full word set + both letter sets + hmm + deflate; bake-off voices:
their frozen subsets + hmm + deflate), that every WAV is 24 kHz / mono /
16-bit with a duration of 0.2–6.0 s and a genuinely silent tail (catches
the empty-audio, read-the-instructions-aloud, and missing-tail-conditioning
failure modes), and that `manifest.js` matches the word list in order with
no orphan files under `renderer/audio/`. Every failure prints on its own
line plus a per-voice summary; the exit status is 0 only when fully clean.
Run it after every generation pass and before committing clips.

---

## Changing the voice or re-rendering the full set

To switch to a different voice and regenerate everything:

```sh
# 1. Run once without --force to see what's already there:
python3 tools/tts/generate_clips.py --voices aoede

# 2. Re-render everything for that voice, overwriting existing clips:
python3 tools/tts/generate_clips.py --voices aoede --force
```

To update the primary voice: change `PRIMARY_VOICE` in `generate_clips.py`
and make sure the new voice is in the `VOICES` dict with the correct API
casing, then run `--force`.

---

## Output layout

```
renderer/audio/
  manifest.js                     # generated — do not edit by hand
  callirrhoe/                     # primary (gate pick)
    words/
      the.wav
      and.wav
      … (every wordlist.txt word)
    letters-phonemic/
      a.wav  b.wav  … z.wav       # phonetic sounds ("ah", "buh", …)
    letters-name/
      a.wav  b.wav  … z.wav       # letter names ("ay", "bee", …)
    phonemes/
      aa.wav  ae.wav  … zh.wav    # 39 ARPABET phonemes (American English)
    hmm.wav
    deflate.wav
  sulafat/                        # comparison voice, subset only
    words/  cat.wav  sun.wav  apple.wav  the.wav  run.wav
    letters-phonemic/  c.wav  a.wav  t.wav
    hmm.wav
    deflate.wav
  aoede/
    … (same subset as sulafat)
```

### Phoneme clips (`phonemes/`)

The 39 ARPABET phonemes of American English, generated for the primary
voice only. These are optimised for concatenation: after the standard
tail conditioning, each clip gets:

1. **Leading/trailing silence trim** (energy threshold
   `PHONEME_ENERGY_THRESHOLD`) with a short head/tail pad to preserve
   the attack transient.
2. **Fade-in** (`PHONEME_FADE_IN_MS`) and **fade-out**
   (`PHONEME_FADE_OUT_MS`) to eliminate clicks at splice points.
3. **RMS normalisation** to `PHONEME_RMS_TARGET` so no phoneme jumps
   out of a concatenated sequence.

All five constants are in `generate_clips.py` and are labelled
ear-tuning candidates.  Iterate after the first render:

```sh
export OPENROUTER_API_KEY=sk-or-v1-...
python3 tools/tts/generate_clips.py --primary-only --force
python3 tools/tts/test_phonemes.py cat dog ship fish sun chop
# A/B tmp/phoneme-test/<word>.wav vs <word>_reference.wav
```

---

## WAV / PCM format details

- **Sample rate:** 24 000 Hz (parsed from the response Content-Type /
  mimeType rather than assumed)
- **Encoding:** signed 16-bit little-endian PCM (L16)
- **Channels:** mono (1)
- **Container:** RIFF WAV (stdlib `wave` module)
- **Tail conditioning:** a 40 ms half-cosine fade-out plus 80 ms of trailing
  silence is applied to every PCM clip before wrapping. Raw clips sometimes
  end on a hot sample, which played as an audible click/cut-off at the gate.
  Knobs: `FADE_OUT_MS` / `TAIL_PAD_MS` in `generate_clips.py`.

If the API returns an already-containerized file (WAV, MP3, or Ogg — detected
by magic bytes), the bytes are written verbatim with the correct extension
instead of being re-wrapped (no tail conditioning). The manifest's `ext`
field reflects the actual extension used.

---

## Troubleshooting

| Problem | Action |
|---------|--------|
| `no API key set for --api …` | Export the env var named in the error before running. |
| Model missing from `GET /api/v1/models` | Expected — TTS models are hidden from the public list. Use `--list-models` (endpoint check) instead. |
| "No endpoints found that support the requested output modalities" | You are calling `chat/completions`; TTS models only work via `/api/v1/audio/speech`. The current script does this. |
| HTTP 404 / model not found on `/audio/speech` | Run `--list-models`; update the model via `--model`, `OPENROUTER_TTS_MODEL`, or `API_CONFIGS`. |
| HTTP 200 but empty body / absurdly long clip | The model mishandled the prompt text. For words this is why the target is quoted (see Style prompt above); if it recurs, reword the prompt or quote the content. |
| `extract_audio_gemini` RuntimeError (fallback route) | Run `--api gemini --probe` to see which JSON keys return; update the named function. |
| Clips sound robotic / wrong voice | Adjust voice casing in the `VOICES` dict; re-run with `--force`. |
| Rate-limit (HTTP 429) | The script retries automatically with exponential backoff (1s, 2s, 4s). If limits persist, increase `INTER_CALL_SLEEP` at the top of the script. |
