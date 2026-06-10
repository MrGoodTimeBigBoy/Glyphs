# Glyphs — TTS Audio Pipeline

> **STATUS (2026-06-10): generation is blocked on a provider/voice decision.**
> The plan-of-record route — Google Gemini Flash TTS **through OpenRouter** —
> turned out not to exist: OpenRouter routes **no Gemini TTS model at all**
> (verified against `GET /api/v1/models`; every `google/gemini-*` model there
> is text/image-only, and the router rejects audio modalities for them).
> Two working routes were verified instead; Ian picks one:
>
> | Route | Status | Voices | Command |
> |-------|--------|--------|---------|
> | **A. Gemini API direct** (`generativelanguage.googleapis.com`) | Reachable from the container; **needs `GEMINI_API_KEY`** (not yet set) | **Sulafat / Aoede / Callirrhoe** — the original bake-off, preserved exactly | `--api gemini` |
> | **B. OpenRouter → `openai/gpt-audio`** (streaming) | **Verified working end-to-end** with the existing `OPENROUTER_API_KEY` | OpenAI voices — **cedar / marin / coral** bake-off (configurable) | default (`--api openrouter`) |
>
> The probe for route B produced a clean 24 kHz mono WAV ("cat", voice cedar).
> Route A's request/response contract is implemented per Google's documented
> shape but needs one `--probe` with a real key to confirm.

## Approach

Glyphs uses **pre-rendered TTS clips** generated offline. All audio is bundled
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

## Backends, models, and voices

The generator (`generate_clips.py`) supports two backends via `--api`:

### `--api openrouter` (default)

| Role | Value |
|------|-------|
| **API** | OpenRouter — `POST https://openrouter.ai/api/v1/chat/completions` |
| **Key** | `OPENROUTER_API_KEY` |
| **Model** | `openai/gpt-audio` (override: `--model` / `OPENROUTER_TTS_MODEL`; `openai/gpt-audio-mini` is the cheaper sibling) |
| **Transport** | **`stream: true` is required** — OpenRouter rejects non-streaming audio requests. Audio arrives as base64 **PCM16** chunks in `choices[0].delta.audio.data`; the script concatenates and wraps them into WAV. |
| **Primary voice** | **cedar** — full word set + all letters (phonemic and name) + hmm |
| **Bake-off voices** | **marin**, **coral** — subset only |

### `--api gemini` (Gemini API direct — preserves the original voice plan)

| Role | Value |
|------|-------|
| **API** | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` |
| **Key** | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
| **Model** | `gemini-2.5-flash-preview-tts` — best guess; confirm with `--api gemini --list-models` and override with `--model` / `GEMINI_TTS_MODEL` |
| **Transport** | Non-streaming `generateContent` with `responseModalities: ["AUDIO"]` and a `prebuiltVoiceConfig` voice. Audio returns as base64 L16 PCM in `candidates[0].content.parts[*].inlineData`; the sample rate is parsed from the `mimeType`. |
| **Primary voice** | **Sulafat** — full word set + all letters (phonemic and name) + hmm |
| **Bake-off voices** | **Aoede**, **Callirrhoe** — subset only |

Both backends emit **WAV / PCM 24 kHz mono, 16-bit signed little-endian** and
share all prompts, spellings, the output layout, and the manifest format. Voice
names live in one place (`API_CONFIGS` in `generate_clips.py`) — adjust there
if an API rejects a voice id.

### Style prompt

All clips use an expressive-storyteller style:

> "Read this aloud in a clear, warm, friendly voice, like a gentle storyteller
> reading to a young child. Natural and unhurried:"

Phonemic letter clips use a separate prompt that instructs the model to produce
only the **phonetic sound** (not the letter name). The prompts are defined as
module-level constants in `generate_clips.py` and are easy to adjust.

### Bake-off subset

The two bake-off voices receive a reduced clip set for evaluation purposes:

- Words: `cat sun apple the run`
- Phonemic letters: `c a t`
- hmm

After listening and choosing a preferred voice, run a full pass with that
voice using `--voices <chosen> --force`.

---

## Prerequisites

1. **Python 3** — standard library only, no `pip install` required.
2. **An API key** in the environment:
   - route B (default): `OPENROUTER_API_KEY` (https://openrouter.ai/settings/keys)
   - route A: `GEMINI_API_KEY` (https://aistudio.google.com/apikey)
3. **Network access** to `openrouter.ai` or `generativelanguage.googleapis.com`
   at generation time (clips are generated once and committed; the app itself
   is fully offline). Both hosts are reachable from the current container
   environment.

---

## Commands

### Step 1 — probe (always run this first on a new machine)

```sh
# Route B (OpenRouter / gpt-audio — works with the key already in the env):
python3 tools/tts/generate_clips.py --probe

# Route A (Gemini direct — once GEMINI_API_KEY is set):
python3 tools/tts/generate_clips.py --api gemini --probe
```

This generates exactly **one clip** (the word "cat", the backend's primary
voice), prints the API response structure and the detected audio format, and
writes the clip to `renderer/audio/<primary>/words/cat.wav`. Inspect the
output to confirm:

- The model ID is accepted (no "model not found" error).
- Audio data is present in the response (the probe prints where it was found).
- The written WAV file plays correctly.

If the model ID or response shape differs from expectation, the probe output
tells you exactly which JSON keys were seen. Update `API_CONFIGS`,
`collect_openrouter_stream()`, or `extract_audio_gemini()` accordingly (one
obvious place in the script for each).

To see what models a backend can actually serve:

```sh
python3 tools/tts/generate_clips.py --list-models
python3 tools/tts/generate_clips.py --api gemini --list-models
```

### Step 2 — full run

```sh
python3 tools/tts/generate_clips.py              # route B
python3 tools/tts/generate_clips.py --api gemini # route A
```

Or via npm (route B defaults):

```sh
npm run gen-clips
```

This generates all clips for all of the backend's voices (primary full set +
two bake-off subsets) and writes `renderer/audio/manifest.js`.

### Other useful invocations

```sh
# Re-generate everything for one voice (overwrite existing):
python3 tools/tts/generate_clips.py --api gemini --voices sulafat --force

# Primary voice only (skip bake-off voices):
python3 tools/tts/generate_clips.py --primary-only

# Use a specific model ID (e.g. after confirming via --list-models):
python3 tools/tts/generate_clips.py --model openai/gpt-audio-mini

# Generate from a custom word list:
python3 tools/tts/generate_clips.py --words path/to/mywords.txt

# Write clips to a different directory (e.g. a throwaway probe):
python3 tools/tts/generate_clips.py --probe --out /tmp/audio-test
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
python3 tools/tts/generate_clips.py --api gemini --voices aoede

# 2. Re-render everything for that voice, overwriting existing clips:
python3 tools/tts/generate_clips.py --api gemini --voices aoede --force
```

To update a backend's primary voice: change its `primary` entry in
`API_CONFIGS` in `generate_clips.py` (and make sure the voice is in its
`voices` dict with the correct API casing), then run `--force`.

---

## Output layout

```
renderer/audio/
  manifest.js                     # generated — do not edit by hand
  <primary>/                      # sulafat (route A) or cedar (route B)
    words/
      the.wav
      and.wav
      … (all 20 words)
    letters-phonemic/
      a.wav  b.wav  … z.wav       # phonetic sounds ("ah", "buh", …)
    letters-name/
      a.wav  b.wav  … z.wav       # letter names ("ay", "bee", …)
    hmm.wav
  <bakeoff-1>/                    # aoede / marin
    words/  cat.wav  sun.wav  apple.wav  the.wav  run.wav
    letters-phonemic/  c.wav  a.wav  t.wav
    hmm.wav
  <bakeoff-2>/                    # callirrhoe / coral
    … (same bake-off subset)
```

The renderer reads voice names from `manifest.js`, so either route's
directory names work unchanged in the test harness (Tab cycles whatever
voices the manifest lists).

---

## WAV / PCM format details

- **Sample rate:** 24 000 Hz (both backends' default; the Gemini path parses
  the actual rate from the response `mimeType`)
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
| HTTP 404 / model not found | Run `--list-models` for the backend; update the model via `--model` or `API_CONFIGS`. |
| "Audio output requires stream: true" (OpenRouter) | You are on an old script version — the streaming backend handles this; update. |
| "No endpoints found that support the requested output modalities" (OpenRouter) | The model can't produce audio on OpenRouter. `--list-models` shows which can (as of 2026-06: only `openai/gpt-audio[-mini]` for speech). |
| `collect_openrouter_stream` / `extract_audio_gemini` RuntimeError | Run `--probe` to see which JSON keys the API returns; update the named function. |
| Clips sound robotic / wrong voice | Adjust voice ids/casing in `API_CONFIGS`; re-run with `--force`. |
| Rate-limit (HTTP 429) | The script retries automatically with exponential backoff (1s, 2s, 4s). If limits persist, increase `INTER_CALL_SLEEP` at the top of the script. |
