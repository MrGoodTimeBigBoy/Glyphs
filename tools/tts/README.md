# Glyphs — TTS Audio Pipeline

## Approach

Glyphs uses **pre-rendered TTS clips** generated offline via the
[OpenRouter](https://openrouter.ai/) API (Google Gemini Flash TTS model).
All audio is bundled with the app as plain WAV files under `renderer/audio/`.

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
| **API** | OpenRouter — `POST https://openrouter.ai/api/v1/chat/completions` |
| **Model** | `google/gemini-3.1-flash-tts-preview` (confirm against `/api/v1/models`) |
| **Primary voice** | **Sulafat** — full word set + all letters (phonemic and name) + hmm |
| **Bake-off voices** | **Aoede**, **Callirrhoe** — subset only (see below) |
| **Output format** | WAV / PCM 24 kHz mono, 16-bit signed little-endian |

### Style prompt

All clips use an expressive-storyteller style:

> "Read this aloud in a clear, warm, friendly voice, like a gentle storyteller
> reading to a young child. Natural and unhurried:"

Phonemic letter clips use a separate prompt that instructs the model to produce
only the **phonetic sound** (not the letter name). The prompts are defined as
module-level constants in `generate_clips.py` and are easy to adjust.

### Bake-off subset

The bake-off voices (Aoede, Callirrhoe) receive a reduced clip set for
evaluation purposes:

- Words: `cat sun apple the run`
- Phonemic letters: `c a t`
- hmm

After listening and choosing a preferred voice, run a full pass with that
voice using `--voices <chosen> --force`.

---

## Prerequisites

1. **Python 3** — standard library only, no `pip install` required.
2. **`OPENROUTER_API_KEY`** environment variable — an OpenRouter API key
   (get one at https://openrouter.ai/settings/keys).
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
the API response keys and the detected audio format, and writes the clip to
`renderer/audio/sulafat/words/cat.wav`. Inspect the output to confirm:

- The model ID is accepted (no "model not found" error).
- Audio data is present in the response (the probe prints where it was found).
- The written WAV file plays correctly.

If the model ID or response shape differs from expectation, the probe output
tells you exactly which JSON keys were seen. Update `DEFAULT_MODEL` or
`extract_audio_bytes()` accordingly (one obvious place in the script for each).

### Step 2 — full run

```sh
python3 tools/tts/generate_clips.py
```

Or via npm:

```sh
npm run gen-clips
```

This generates all clips for all voices (primary Sulafat + bake-off Aoede and
Callirrhoe) and writes `renderer/audio/manifest.js`.

### Other useful invocations

```sh
# Full run with progress output, skipping files that already exist:
python3 tools/tts/generate_clips.py

# Re-generate everything for one voice (overwrite existing):
python3 tools/tts/generate_clips.py --voices sulafat --force

# Primary voice only (skip bake-off voices):
python3 tools/tts/generate_clips.py --primary-only

# Use a specific model ID (e.g. after confirming from /api/v1/models):
python3 tools/tts/generate_clips.py --model google/gemini-flash-tts-1

# Generate from a custom word list:
python3 tools/tts/generate_clips.py --words path/to/mywords.txt

# Write clips to a different directory:
python3 tools/tts/generate_clips.py --out /tmp/audio-test
```

---

## Adding more words

1. Add the new word(s) to `tools/tts/wordlist.txt` (one word per line).
2. Run the generator — it is **idempotent**: existing clips are skipped
   automatically. Only the new words are fetched from the API.

```sh
echo "rainbow" >> tools/tts/wordlist.txt
python3 tools/tts/generate_clips.py --primary-only
```

The manifest is rewritten after each run to reflect what was actually produced.

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
and add the new voice to the `VOICES` dict with the correct API casing, then
run `--force`.

---

## Output layout

```
renderer/audio/
  manifest.js                     # generated — do not edit by hand
  sulafat/
    words/
      the.wav
      and.wav
      … (all 20 words)
    letters-phonemic/
      a.wav  b.wav  … z.wav       # phonetic sounds ("ah", "buh", …)
    letters-name/
      a.wav  b.wav  … z.wav       # letter names ("ay", "bee", …)
    hmm.wav
  aoede/
    words/  cat.wav  sun.wav  apple.wav  the.wav  run.wav
    letters-phonemic/  c.wav  a.wav  t.wav
    hmm.wav
  callirrhoe/
    … (same bake-off subset as aoede)
```

---

## WAV / PCM format details

- **Sample rate:** 24 000 Hz (Gemini TTS default)
- **Encoding:** signed 16-bit little-endian PCM (L16)
- **Channels:** mono (1)
- **Container:** RIFF WAV (stdlib `wave` module)

If the API returns an already-containerized file (WAV, MP3, or Ogg — detected
by magic bytes), the bytes are written verbatim with the correct extension
instead of being re-wrapped. The manifest's `ext` field reflects the actual
extension used.

---

## Troubleshooting

| Problem | Action |
|---------|--------|
| `OPENROUTER_API_KEY not set` | Export the env var before running. |
| HTTP 404 / model not found | Check model ID via `GET https://openrouter.ai/api/v1/models`; update `DEFAULT_MODEL` in the script. |
| `extract_audio_bytes` RuntimeError | Run `--probe` to see which JSON keys the API returns; update `extract_audio_bytes()` in the script. |
| Clips sound robotic / wrong voice | Adjust voice casing in the `VOICES` dict; re-run with `--force`. |
| Rate-limit (HTTP 429) | The script retries automatically with exponential backoff (1s, 2s, 4s). If limits persist, increase `INTER_CALL_SLEEP` at the top of the script. |
