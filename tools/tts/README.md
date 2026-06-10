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
| **Primary voice** | **Sulafat** — full word set + all letters (phonemic and name) + hmm |
| **Bake-off voices** | **Aoede**, **Callirrhoe** — subset only (see below) |
| **Output format** | WAV / PCM 24 kHz mono, 16-bit signed little-endian |

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

### Style prompt

All clips use an expressive-storyteller style:

> "Read this aloud in a clear, warm, friendly voice, like a gentle storyteller
> reading to a young child. Natural and unhurried:"

**Word clips put the target word in double quotes** after that prompt. This is
load-bearing, not cosmetic: with a bare word after the colon, the model
returned *empty audio* for short function words ("and", "go", "me", …) and
read the instruction itself aloud for ~20 seconds for "the". Quoting fixed
every case (verified 2026-06-10).

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
the response Content-Type and detected audio format, and writes the clip to
`renderer/audio/sulafat/words/cat.wav`. Inspect the output to confirm:

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

This generates all clips for all voices (primary Sulafat + bake-off Aoede and
Callirrhoe) and writes `renderer/audio/manifest.js`.

### Other useful invocations

```sh
# Re-generate everything for one voice (overwrite existing):
python3 tools/tts/generate_clips.py --voices sulafat --force

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
and make sure the new voice is in the `VOICES` dict with the correct API
casing, then run `--force`.

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

- **Sample rate:** 24 000 Hz (parsed from the response Content-Type /
  mimeType rather than assumed)
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
| `no API key set for --api …` | Export the env var named in the error before running. |
| Model missing from `GET /api/v1/models` | Expected — TTS models are hidden from the public list. Use `--list-models` (endpoint check) instead. |
| "No endpoints found that support the requested output modalities" | You are calling `chat/completions`; TTS models only work via `/api/v1/audio/speech`. The current script does this. |
| HTTP 404 / model not found on `/audio/speech` | Run `--list-models`; update the model via `--model`, `OPENROUTER_TTS_MODEL`, or `API_CONFIGS`. |
| HTTP 200 but empty body / absurdly long clip | The model mishandled the prompt text. For words this is why the target is quoted (see Style prompt above); if it recurs, reword the prompt or quote the content. |
| `extract_audio_gemini` RuntimeError (fallback route) | Run `--api gemini --probe` to see which JSON keys return; update the named function. |
| Clips sound robotic / wrong voice | Adjust voice casing in the `VOICES` dict; re-run with `--force`. |
| Rate-limit (HTTP 429) | The script retries automatically with exponential backoff (1s, 2s, 4s). If limits persist, increase `INTER_CALL_SLEEP` at the top of the script. |
