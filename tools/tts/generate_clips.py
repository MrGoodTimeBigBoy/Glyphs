#!/usr/bin/env python3
"""
generate_clips.py — Glyphs Phase 2 TTS clip generator.

Generates short speech clips and writes them under renderer/audio/ plus a
generated renderer/audio/manifest.js.

Two API backends (--api):

  openrouter  POST https://openrouter.ai/api/v1/chat/completions
              Audio output on OpenRouter REQUIRES stream:true (verified
              2026-06-10: non-streaming requests are rejected with
              "Audio output requires stream: true"). Audio arrives as
              base64 PCM chunks in choices[0].delta.audio.data.
              NOTE: OpenRouter routes NO Gemini TTS model (verified
              2026-06-10 against GET /api/v1/models — every google/gemini-*
              model is text/image-only). The only speech-capable models
              there are openai/gpt-audio and openai/gpt-audio-mini, so this
              backend uses OpenAI voices.

  gemini      POST https://generativelanguage.googleapis.com/v1beta/
                   models/{model}:generateContent
              Google's Gemini API direct — the route that preserves the
              originally chosen Gemini voices (Sulafat / Aoede / Callirrhoe).
              Requires GEMINI_API_KEY (or GOOGLE_API_KEY).

Standard library only: no pip install required.
Runs unchanged on macOS and Linux.

Usage:
    python3 tools/tts/generate_clips.py --probe
    python3 tools/tts/generate_clips.py --api gemini --probe
    python3 tools/tts/generate_clips.py --list-models
    python3 tools/tts/generate_clips.py
    python3 tools/tts/generate_clips.py --api gemini
    python3 tools/tts/generate_clips.py --force
    python3 tools/tts/generate_clips.py --primary-only
    python3 tools/tts/generate_clips.py --model openai/gpt-audio-mini
    python3 tools/tts/generate_clips.py --api gemini --voices sulafat --force
"""

import argparse
import base64
import io
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request
import wave

# ---------------------------------------------------------------------------
# API / model / voice configuration
# ---------------------------------------------------------------------------

# Per-backend defaults. Voice dicts map directory name (lowercase, used in
# renderer/audio/<voice>/...) to the API voice string sent in the request.
# If the API rejects a voice name, this is the single place to fix it.
#
# The Gemini default model ID is a best guess; confirm with:
#     python3 tools/tts/generate_clips.py --api gemini --list-models
# and override via --model or the env var named below if it has moved on.
API_CONFIGS = {
    "openrouter": {
        "default_model": "openai/gpt-audio",
        "model_env":     "OPENROUTER_TTS_MODEL",
        "key_env":       ["OPENROUTER_API_KEY"],
        "primary":       "cedar",
        "bakeoff":       ["marin", "coral"],
        "voices": {
            "cedar": "cedar",
            "marin": "marin",
            "coral": "coral",
        },
    },
    "gemini": {
        "default_model": "gemini-2.5-flash-preview-tts",
        "model_env":     "GEMINI_TTS_MODEL",
        "key_env":       ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "primary":       "sulafat",
        "bakeoff":       ["aoede", "callirrhoe"],
        "voices": {
            "sulafat":    "Sulafat",
            "aoede":      "Aoede",
            "callirrhoe": "Callirrhoe",
        },
    },
}

DEFAULT_API = "openrouter"

# Words and special tokens that make up the bake-off subset.
BAKEOFF_WORDS = ["cat", "sun", "apple", "the", "run"]
BAKEOFF_LETTERS = ["c", "a", "t"]  # phonemic only
BAKEOFF_HMM = True

# ---------------------------------------------------------------------------
# Style prompts
# ---------------------------------------------------------------------------

# Base storyteller style applied before most content.
STYLE = (
    "Read this aloud in a clear, warm, friendly voice, like a gentle "
    "storyteller reading to a young child. Natural and unhurried:"
)

# Specialised prompts for each content type.
PROMPT_WORD = STYLE  # + " " + word

PROMPT_PHONEMIC = (
    "Say only this letter sound, clearly and warmly, the way you sound out "
    "a letter for a young child (do not say the letter's name):"
)

PROMPT_LETTER_NAME = "Say the name of this letter, clearly and warmly:"

PROMPT_HMM = (
    "Say a soft, thoughtful 'hmm', warm and curious, as if gently wondering:"
)

# ---------------------------------------------------------------------------
# Phonemic and letter-name spellings
# ---------------------------------------------------------------------------

# Text fed to TTS for each letter's phonemic/short sound.
PHONEMIC_MAP = {
    "a": "ah", "b": "buh", "c": "kuh", "d": "duh", "e": "eh",
    "f": "ff",  "g": "guh", "h": "huh", "i": "ih",  "j": "juh",
    "k": "kuh", "l": "ll",  "m": "mm",  "n": "nn",  "o": "aw",
    "p": "puh", "q": "kwuh","r": "rr",  "s": "ss",  "t": "tuh",
    "u": "uh",  "v": "vv",  "w": "wuh", "x": "ks",  "y": "yuh",
    "z": "zz",
}

# Text fed to TTS for each letter's name.
LETTER_NAME_MAP = {
    "a": "ay",        "b": "bee",    "c": "see",       "d": "dee",
    "e": "ee",        "f": "eff",    "g": "jee",       "h": "aitch",
    "i": "eye",       "j": "jay",    "k": "kay",       "l": "el",
    "m": "em",        "n": "en",     "o": "oh",        "p": "pee",
    "q": "cue",       "r": "ar",     "s": "ess",       "t": "tee",
    "u": "you",       "v": "vee",    "w": "double-you", "x": "ex",
    "y": "why",       "z": "zee",
}

# ---------------------------------------------------------------------------
# API constants
# ---------------------------------------------------------------------------

OPENROUTER_BASE = "https://openrouter.ai/api/v1"
OPENROUTER_CHAT = f"{OPENROUTER_BASE}/chat/completions"
OPENROUTER_MODELS = f"{OPENROUTER_BASE}/models"
HTTP_REFERER    = "https://glyphs.local"
APP_TITLE       = "Glyphs"

GEMINI_BASE   = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_MODELS = f"{GEMINI_BASE}/models"

INTER_CALL_SLEEP  = 0.4   # seconds between API calls
RETRY_ATTEMPTS    = 3
RETRY_BASE_SLEEP  = 1.0   # seconds; doubles each retry (1, 2, 4)

# ---------------------------------------------------------------------------
# Magic bytes for audio-container detection
# ---------------------------------------------------------------------------

MAGIC_RIFF  = b"RIFF"   # WAV
MAGIC_ID3   = b"ID3"    # MP3 with ID3 tag
MAGIC_MP3   = bytes([0xFF, 0xFB])  # MP3 sync word (no ID3)
MAGIC_OGG   = b"OggS"  # Ogg/Vorbis

def detect_audio_format(data: bytes):
    """Return (extension, is_container) for raw bytes.

    Returns:
        ("wav", True)  — already a WAV container; write verbatim.
        ("mp3", True)  — already an MP3; write verbatim.
        ("ogg", True)  — already Ogg; write verbatim.
        ("wav", False) — raw PCM; needs WAV header wrapping.
    """
    if data[:4] == MAGIC_RIFF:
        return "wav", True
    if data[:3] == MAGIC_ID3:
        return "mp3", True
    if data[:2] == MAGIC_MP3:
        return "mp3", True
    if data[:4] == MAGIC_OGG:
        return "ogg", True
    # Assume raw L16 PCM; caller wraps it.
    return "wav", False

# ---------------------------------------------------------------------------
# PCM → WAV helper
# ---------------------------------------------------------------------------

def pcm_to_wav(pcm_bytes: bytes, sample_rate: int = 24000,
               channels: int = 1, sample_width: int = 2) -> bytes:
    """Wrap raw signed 16-bit little-endian PCM into a WAV byte string.

    Args:
        pcm_bytes:    Raw PCM audio data (signed 16-bit, little-endian).
        sample_rate:  Samples per second (default 24000 Hz, both APIs' default).
        channels:     Number of channels (default 1 = mono).
        sample_width: Bytes per sample (default 2 = 16-bit).

    Returns:
        Bytes of a valid WAV file readable by the stdlib `wave` module.
    """
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()

def finalize_audio(raw: bytes, sample_rate: int = 24000) -> tuple[bytes, str]:
    """Turn raw API audio bytes into writable file bytes + extension.

    Container formats (detected by magic bytes) pass through verbatim;
    bare PCM is wrapped in a WAV header at the given sample rate.
    """
    ext, is_container = detect_audio_format(raw)
    if not is_container:
        return pcm_to_wav(raw, sample_rate=sample_rate), "wav"
    return raw, ext

# ---------------------------------------------------------------------------
# HTTP helper with retry
# ---------------------------------------------------------------------------

def http_with_retry(make_request, consume):
    """Run an HTTP call with retry on 429/5xx and network errors.

    Args:
        make_request: () -> urllib.request.Request (rebuilt each attempt;
                      a Request object cannot be reused after a failure).
        consume:      (http_response) -> result. Reads the body inside the
                      open connection. Its return value is returned as-is.

    Raises:
        RuntimeError on non-retryable HTTP errors (with response body) or
        after all retries are exhausted.
    """
    last_exc = None
    for attempt in range(RETRY_ATTEMPTS):
        if attempt > 0:
            sleep_s = RETRY_BASE_SLEEP * (2 ** (attempt - 1))
            print(f"    [retry {attempt}/{RETRY_ATTEMPTS - 1}] sleeping {sleep_s:.0f}s …",
                  file=sys.stderr)
            time.sleep(sleep_s)

        try:
            with urllib.request.urlopen(make_request(), timeout=120) as resp:
                return consume(resp)
        except urllib.error.HTTPError as exc:
            status = exc.code
            if status in (429, 500, 502, 503, 504):
                last_exc = exc
                continue
            # Non-retryable HTTP error — read body for diagnostics and raise.
            err_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {status}:\n{err_body}") from exc
        except OSError as exc:
            # Network-level error (connection refused, timeout, etc.)
            last_exc = exc
            continue

    raise RuntimeError(
        f"All {RETRY_ATTEMPTS} API attempts failed. Last error: {last_exc}"
    )

# ---------------------------------------------------------------------------
# OpenRouter backend (streaming — audio output requires stream:true)
# ---------------------------------------------------------------------------

def openrouter_request(text: str, voice_api: str, model: str,
                       api_key: str) -> urllib.request.Request:
    """Build the streaming chat-completions request for OpenRouter."""
    payload = {
        "model": model,
        "modalities": ["text", "audio"],
        # Streaming audio is delivered as raw PCM chunks; "wav" is not
        # accepted in streaming mode. We wrap PCM → WAV ourselves.
        "audio": {"voice": voice_api, "format": "pcm16"},
        "stream": True,
        "messages": [{"role": "user", "content": text}],
    }
    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Content-Type":   "application/json",
        "HTTP-Referer":   HTTP_REFERER,
        "X-Title":        APP_TITLE,
    }
    return urllib.request.Request(OPENROUTER_CHAT,
                                  data=json.dumps(payload).encode("utf-8"),
                                  headers=headers, method="POST")

def collect_openrouter_stream(resp) -> tuple[bytes, dict]:
    """Read an OpenRouter SSE stream; return (audio_bytes, diagnostics).

    Audio arrives base64-encoded in choices[0].delta.audio.data across many
    events. Diagnostics carry the delta/audio keys seen and the transcript,
    so a contract change is identifiable from probe output alone.
    """
    chunks: list[bytes] = []
    diag = {"events": 0, "delta_keys": set(), "audio_keys": set(),
            "transcript": []}
    for line in resp:
        line = line.decode("utf-8", errors="replace").strip()
        if not line.startswith("data: "):
            continue   # ignore SSE comments / keep-alives
        data = line[len("data: "):]
        if data == "[DONE]":
            break
        try:
            obj = json.loads(data)
        except json.JSONDecodeError:
            continue
        diag["events"] += 1
        delta = (obj.get("choices") or [{}])[0].get("delta", {})
        diag["delta_keys"].update(delta.keys())
        audio = delta.get("audio")
        if isinstance(audio, dict):
            diag["audio_keys"].update(audio.keys())
            if audio.get("data"):
                chunks.append(base64.b64decode(audio["data"]))
            if audio.get("transcript"):
                diag["transcript"].append(audio["transcript"])
    return b"".join(chunks), diag

def call_tts_openrouter(text: str, voice_api: str, model: str,
                        api_key: str) -> tuple[bytes, str]:
    """Generate one clip via OpenRouter; return (file_bytes, extension)."""
    raw, diag = http_with_retry(
        lambda: openrouter_request(text, voice_api, model, api_key),
        collect_openrouter_stream,
    )
    if not raw:
        raise RuntimeError(
            "OpenRouter stream contained no audio data.\n"
            f"  SSE events parsed:   {diag['events']}\n"
            f"  delta keys seen:     {sorted(diag['delta_keys'])}\n"
            f"  delta.audio keys:    {sorted(diag['audio_keys'])}\n"
            "  Inspect with --probe and update collect_openrouter_stream() "
            "if the response shape has changed."
        )
    return finalize_audio(raw)

# ---------------------------------------------------------------------------
# Gemini-direct backend (generativelanguage.googleapis.com)
# ---------------------------------------------------------------------------

def gemini_request(text: str, voice_api: str, model: str,
                   api_key: str) -> urllib.request.Request:
    """Build the generateContent request for the Gemini API."""
    payload = {
        "contents": [{"parts": [{"text": text}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {
                    "prebuiltVoiceConfig": {"voiceName": voice_api}
                }
            },
        },
    }
    headers = {
        "x-goog-api-key": api_key,   # header, not URL param: keeps the key out of logs
        "Content-Type":   "application/json",
    }
    url = f"{GEMINI_BASE}/models/{model}:generateContent"
    return urllib.request.Request(url,
                                  data=json.dumps(payload).encode("utf-8"),
                                  headers=headers, method="POST")

def extract_audio_gemini(response_json: dict) -> tuple[bytes, int]:
    """Extract (pcm_or_container_bytes, sample_rate) from a Gemini response.

    Expected shape: candidates[0].content.parts[*].inlineData
    with {"mimeType": "audio/L16;codec=pcm;rate=24000", "data": "<base64>"}.
    Raises RuntimeError with structural diagnostics if no audio is found.
    """
    candidates = response_json.get("candidates", [])
    for cand in candidates:
        parts = (cand.get("content") or {}).get("parts", [])
        for part in parts:
            inline = part.get("inlineData") or part.get("inline_data")
            if not isinstance(inline, dict):
                continue
            data_b64 = inline.get("data")
            if not data_b64:
                continue
            raw = base64.b64decode(data_b64)
            mime = inline.get("mimeType") or inline.get("mime_type") or ""
            rate_match = re.search(r"rate=(\d+)", mime)
            rate = int(rate_match.group(1)) if rate_match else 24000
            return raw, rate

    top_keys = list(response_json.keys())
    part_keys: list = []
    if candidates:
        parts = (candidates[0].get("content") or {}).get("parts", [])
        part_keys = [list(p.keys()) for p in parts]
    raise RuntimeError(
        "extract_audio_gemini: could not find audio data in response.\n"
        f"  Top-level keys seen:        {top_keys}\n"
        f"  candidates[0] part keys:    {part_keys}\n"
        "  Inspect the full response JSON and update extract_audio_gemini() "
        "with the correct field path."
    )

def call_tts_gemini(text: str, voice_api: str, model: str,
                    api_key: str) -> tuple[bytes, str]:
    """Generate one clip via the Gemini API; return (file_bytes, extension)."""
    response_json = http_with_retry(
        lambda: gemini_request(text, voice_api, model, api_key),
        lambda resp: json.loads(resp.read()),
    )
    raw, rate = extract_audio_gemini(response_json)
    return finalize_audio(raw, sample_rate=rate)

# ---------------------------------------------------------------------------
# Backend dispatch
# ---------------------------------------------------------------------------

def call_tts_api(api: str, text: str, voice_api: str, model: str,
                 api_key: str) -> tuple[bytes, str]:
    """Generate one clip via the selected backend; return (bytes, ext)."""
    if api == "gemini":
        return call_tts_gemini(text, voice_api, model, api_key)
    return call_tts_openrouter(text, voice_api, model, api_key)

def resolve_api_key(api: str) -> str:
    """Read the backend's API key from the environment or exit with help."""
    env_names = API_CONFIGS[api]["key_env"]
    for name in env_names:
        key = os.environ.get(name)
        if key:
            return key
    hint = {
        "openrouter": "Get a key at https://openrouter.ai/settings/keys",
        "gemini":     "Get a key at https://aistudio.google.com/apikey",
    }[api]
    print(
        f"ERROR: no API key set for --api {api}.\n"
        f"Export one of: {', '.join(env_names)}\n{hint}",
        file=sys.stderr,
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Model listing (--list-models)
# ---------------------------------------------------------------------------

def list_models(api: str, api_key: str | None) -> None:
    """Print the models relevant to TTS for the selected backend."""
    if api == "openrouter":
        # Public endpoint, no key required.
        req = urllib.request.Request(OPENROUTER_MODELS)
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        models = data.get("data", [])
        print(f"[models] OpenRouter lists {len(models)} models; "
              f"those with audio output:")
        found = False
        for m in models:
            arch = m.get("architecture") or {}
            if "audio" in (arch.get("output_modalities") or []):
                print(f"  {m.get('id')}  "
                      f"in={arch.get('input_modalities')}  "
                      f"out={arch.get('output_modalities')}")
                found = True
        if not found:
            print("  (none)")
        return

    # gemini
    req = urllib.request.Request(f"{GEMINI_MODELS}?pageSize=1000",
                                 headers={"x-goog-api-key": api_key})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    models = data.get("models", [])
    print(f"[models] Gemini API lists {len(models)} models; "
          f"those with 'tts' in the name:")
    found = False
    for m in models:
        name = m.get("name", "")          # e.g. "models/gemini-2.5-flash-preview-tts"
        if "tts" in name.lower():
            methods = m.get("supportedGenerationMethods", [])
            print(f"  {name.removeprefix('models/')}  methods={methods}")
            found = True
    if not found:
        print("  (none — inspect the full list manually)")

# ---------------------------------------------------------------------------
# Probe mode
# ---------------------------------------------------------------------------

def run_probe(api: str, model: str, api_key: str, out_dir: pathlib.Path,
              voice_dirname: str, voice_api: str) -> None:
    """Generate ONE clip ('cat', primary voice) and print diagnostic info."""
    prompt = f"{PROMPT_WORD} cat"
    print(f"\n[probe] api={api}  model={model!r}  voice_dir={voice_dirname!r}"
          f"  voice_api={voice_api!r}")
    print(f"[probe] prompt: {prompt!r}")

    if api == "openrouter":
        print(f"[probe] calling {OPENROUTER_CHAT} (streaming) …")
        try:
            with urllib.request.urlopen(
                openrouter_request(prompt, voice_api, model, api_key),
                timeout=120,
            ) as resp:
                raw, diag = collect_openrouter_stream(resp)
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            print(f"[probe] HTTP {exc.code} error:\n{err_body}", file=sys.stderr)
            sys.exit(1)
        print(f"\n[probe] SSE events parsed: {diag['events']}")
        print(f"[probe] delta keys seen:   {sorted(diag['delta_keys'])}")
        print(f"[probe] delta.audio keys:  {sorted(diag['audio_keys'])}")
        print(f"[probe] transcript:        {''.join(diag['transcript'])!r}")
        if not raw:
            print("\n[probe] No audio data in stream — see keys above.",
                  file=sys.stderr)
            sys.exit(1)
        audio_bytes, ext = finalize_audio(raw)
        print(f"[probe] audio: {len(raw)} raw bytes → .{ext} "
              f"({len(audio_bytes)} bytes)")
    else:
        url = f"{GEMINI_BASE}/models/{model}:generateContent"
        print(f"[probe] calling {url} …")
        try:
            with urllib.request.urlopen(
                gemini_request(prompt, voice_api, model, api_key),
                timeout=120,
            ) as resp:
                response_json = json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            print(f"[probe] HTTP {exc.code} error:\n{err_body}", file=sys.stderr)
            sys.exit(1)
        print(f"\n[probe] Top-level response keys: {list(response_json.keys())}")
        try:
            raw, rate = extract_audio_gemini(response_json)
        except RuntimeError as exc:
            print(f"\n[probe] extract_audio_gemini failed:\n{exc}", file=sys.stderr)
            print("\n[probe] Full response JSON (first 2000 chars):")
            print(json.dumps(response_json, indent=2)[:2000])
            sys.exit(1)
        audio_bytes, ext = finalize_audio(raw, sample_rate=rate)
        print(f"[probe] audio: {len(raw)} raw bytes at {rate} Hz → .{ext} "
              f"({len(audio_bytes)} bytes)")

    # Write the single probe clip.
    dest = out_dir / voice_dirname / "words" / f"cat.{ext}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(audio_bytes)
    print(f"[probe] Written: {dest}  ({len(audio_bytes)} bytes)")

# ---------------------------------------------------------------------------
# Clip-generation helpers
# ---------------------------------------------------------------------------

def clip_path(out_dir: pathlib.Path, voice_dirname: str,
              category: str, stem: str) -> pathlib.Path:
    """Return the expected path for a given clip (without extension)."""
    return out_dir / voice_dirname / category / stem

def should_skip(base_path: pathlib.Path, force: bool) -> tuple[bool, pathlib.Path | None]:
    """Return (skip, existing_path).

    Returns True if the file already exists and is non-empty and --force
    is not set; in that case also returns the found path so the caller can
    record the extension.
    """
    if force:
        return False, None
    for ext in ("wav", "mp3", "ogg"):
        p = base_path.with_suffix(f".{ext}")
        if p.exists() and p.stat().st_size > 0:
            return True, p
    return False, None

# ---------------------------------------------------------------------------
# Build clip list for a voice
# ---------------------------------------------------------------------------

def clips_for_voice(words: list[str], voice_dirname: str,
                    is_bakeoff: bool) -> list[dict]:
    """Return a list of clip descriptors for a given voice.

    Each descriptor is a dict:
        {"category": str, "stem": str, "prompt": str}

    Args:
        words:        Full word list.
        voice_dirname: Directory name (lowercase).
        is_bakeoff:   True → only generate the bake-off subset.
    """
    clips = []

    # Words
    word_set = BAKEOFF_WORDS if is_bakeoff else words
    for word in word_set:
        clips.append({
            "category": "words",
            "stem": word,
            "prompt": f"{PROMPT_WORD} {word}",
        })

    # Letters — phonemic sounds
    letter_set = BAKEOFF_LETTERS if is_bakeoff else list(PHONEMIC_MAP.keys())
    for letter in letter_set:
        phonetic = PHONEMIC_MAP[letter]
        clips.append({
            "category": "letters-phonemic",
            "stem": letter,
            "prompt": f"{PROMPT_PHONEMIC} {phonetic}",
        })

    # Letters — names (primary voice only; bake-off voices skip this)
    if not is_bakeoff:
        for letter in LETTER_NAME_MAP:
            name_text = LETTER_NAME_MAP[letter]
            clips.append({
                "category": "letters-name",
                "stem": letter,
                "prompt": f"{PROMPT_LETTER_NAME} {name_text}",
            })

    # hmm
    if is_bakeoff and not BAKEOFF_HMM:
        pass
    else:
        clips.append({
            "category": "hmm",
            "stem": "hmm",
            "prompt": f"{PROMPT_HMM} hmm",
        })

    return clips

# ---------------------------------------------------------------------------
# Manifest generation
# ---------------------------------------------------------------------------

def write_manifest(out_dir: pathlib.Path,
                   primary_voice: str,
                   voices_used: list[str],
                   words_generated: list[str],
                   ext_used: str) -> None:
    """Write renderer/audio/manifest.js from what was actually produced.

    Runs after a successful full (non-probe) pass.
    """
    bakeoff_words_js = json.dumps(BAKEOFF_WORDS)
    voices_js        = json.dumps(voices_used)
    words_js         = json.dumps(words_generated)

    content = f"""\
/* GENERATED by tools/tts/generate_clips.py — do not edit by hand. */
window.Glyphs = window.Glyphs || {{}};
window.Glyphs.audio = window.Glyphs.audio || {{}};
window.Glyphs.audio.manifest = {{
  primary: {json.dumps(primary_voice)},
  voices: {voices_js},
  ext: {json.dumps(ext_used)},
  words: {words_js},
  bakeoffWords: {bakeoff_words_js}
}};
"""
    manifest_path = out_dir / "manifest.js"
    manifest_path.write_text(content, encoding="utf-8")
    print(f"\n[manifest] Written: {manifest_path}")

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        prog="generate_clips.py",
        description=(
            "Generate TTS audio clips for Glyphs via OpenRouter "
            "(openai/gpt-audio, streaming) or the Gemini API direct. "
            "Reads the API key from the environment (see --api)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Confirm the API contract (generates one 'cat' clip, prints diagnostics):
  python3 tools/tts/generate_clips.py --probe
  python3 tools/tts/generate_clips.py --api gemini --probe

  # See which models the backend can serve:
  python3 tools/tts/generate_clips.py --list-models
  python3 tools/tts/generate_clips.py --api gemini --list-models

  # Full run (all voices, all clips):
  python3 tools/tts/generate_clips.py
  python3 tools/tts/generate_clips.py --api gemini

  # Re-render everything for one voice only:
  python3 tools/tts/generate_clips.py --api gemini --voices sulafat --force

  # Primary voice only, skip bake-off voices:
  python3 tools/tts/generate_clips.py --primary-only
        """,
    )
    parser.add_argument(
        "--api", choices=sorted(API_CONFIGS.keys()), default=DEFAULT_API,
        help=(
            "TTS backend: 'openrouter' (openai/gpt-audio via OpenRouter, "
            "needs OPENROUTER_API_KEY) or 'gemini' (Google Gemini API "
            "direct, needs GEMINI_API_KEY; preserves the Sulafat/Aoede/"
            f"Callirrhoe voice plan). Default: {DEFAULT_API!r}."
        ),
    )
    parser.add_argument(
        "--probe", action="store_true",
        help=(
            "Generate one clip (the word 'cat', primary voice) and print "
            "response diagnostics. Does NOT run the full set. Use this to "
            "confirm the API contract before a full run."
        ),
    )
    parser.add_argument(
        "--list-models", action="store_true",
        help="List the backend's TTS-relevant models and exit.",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Overwrite existing clips (default: skip non-empty existing files).",
    )
    parser.add_argument(
        "--model", default=None,
        help=(
            "Model ID override (default: the backend's model env var, "
            "then its built-in default — see API_CONFIGS)."
        ),
    )
    parser.add_argument(
        "--voices", default=None,
        help=(
            "Comma-separated list of voice directory names to generate "
            "(e.g. sulafat,aoede). Default: all of the backend's voices."
        ),
    )
    parser.add_argument(
        "--words", default=None, metavar="FILE",
        help=(
            "Path to word list file (one word per line). "
            "Default: tools/tts/wordlist.txt relative to repo root."
        ),
    )
    parser.add_argument(
        "--out", default=None, metavar="DIR",
        help=(
            "Output directory root (default: renderer/audio relative to "
            "repo root, or next to this script's parent directory)."
        ),
    )
    parser.add_argument(
        "--primary-only", action="store_true",
        help="Skip bake-off voices; only generate the primary voice.",
    )
    return parser.parse_args(argv)


def resolve_repo_root() -> pathlib.Path:
    """Resolve the repository root from this script's location."""
    # tools/tts/generate_clips.py → repo root is two levels up.
    return pathlib.Path(__file__).resolve().parent.parent.parent


def main(argv=None):
    args = parse_args(argv)
    api = args.api
    config = API_CONFIGS[api]

    # ------------------------------------------------------------------
    # Resolve model ID: --model > env > backend default
    # ------------------------------------------------------------------
    model = (
        args.model
        or os.environ.get(config["model_env"])
        or config["default_model"]
    )

    # ------------------------------------------------------------------
    # Model listing (OpenRouter's list is public; Gemini's needs the key)
    # ------------------------------------------------------------------
    if args.list_models:
        api_key = resolve_api_key(api) if api == "gemini" else None
        list_models(api, api_key)
        return

    # ------------------------------------------------------------------
    # API key check — MUST happen before ANY network call.
    # ------------------------------------------------------------------
    api_key = resolve_api_key(api)

    # ------------------------------------------------------------------
    # Resolve output directory
    # ------------------------------------------------------------------
    repo_root = resolve_repo_root()
    if args.out:
        out_dir = pathlib.Path(args.out).resolve()
    else:
        out_dir = repo_root / "renderer" / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Load word list
    # ------------------------------------------------------------------
    if args.words:
        words_file = pathlib.Path(args.words).resolve()
    else:
        words_file = repo_root / "tools" / "tts" / "wordlist.txt"

    if not words_file.exists():
        print(f"ERROR: word list file not found: {words_file}", file=sys.stderr)
        sys.exit(1)

    raw_words = [
        w.strip() for w in words_file.read_text(encoding="utf-8").splitlines()
        if w.strip()
    ]
    if not raw_words:
        print(f"ERROR: word list file is empty: {words_file}", file=sys.stderr)
        sys.exit(1)

    # ------------------------------------------------------------------
    # Resolve voices to generate
    # ------------------------------------------------------------------
    voices_map    = config["voices"]
    primary_voice = config["primary"]
    bakeoff_voices = config["bakeoff"]

    if args.voices:
        requested_voices = [v.strip().lower() for v in args.voices.split(",")]
    elif args.primary_only:
        requested_voices = [primary_voice]
    else:
        requested_voices = [primary_voice] + bakeoff_voices

    # Validate voices.
    unknown = [v for v in requested_voices if v not in voices_map]
    if unknown:
        print(
            f"ERROR: unknown voice(s) for --api {api}: {unknown}. "
            f"Configured voices: {list(voices_map.keys())}",
            file=sys.stderr,
        )
        sys.exit(1)

    # ------------------------------------------------------------------
    # Probe mode
    # ------------------------------------------------------------------
    if args.probe:
        print(f"[probe] api: {api}")
        print(f"[probe] model: {model}")
        print(f"[probe] out_dir: {out_dir}")
        run_probe(api, model, api_key, out_dir,
                  voice_dirname=primary_voice,
                  voice_api=voices_map[primary_voice])
        print("\n[probe] Done. Inspect the output above, then run without "
              "--probe for the full clip set.")
        return

    # ------------------------------------------------------------------
    # Full run
    # ------------------------------------------------------------------
    print(f"\nGlyphs TTS clip generator")
    print(f"  api:     {api}")
    print(f"  model:   {model}")
    print(f"  voices:  {requested_voices}")
    print(f"  words:   {len(raw_words)} words from {words_file}")
    print(f"  out_dir: {out_dir}")
    print(f"  force:   {args.force}")
    print()

    # Track results.
    voice_counts: dict[str, dict] = {}   # voice -> {"ok": n, "skip": n, "err": n, "bytes": n}
    primary_words_generated: list[str] = []
    ext_seen: set[str] = set()

    for voice_dirname in requested_voices:
        is_bakeoff = (voice_dirname != primary_voice) and (voice_dirname in bakeoff_voices)
        clips = clips_for_voice(raw_words, voice_dirname, is_bakeoff)

        print(f"\n── Voice: {voice_dirname} ({'bake-off subset' if is_bakeoff else 'full set'}) "
              f"({len(clips)} clips) ──")

        counts = {"ok": 0, "skip": 0, "err": 0, "bytes": 0}
        voice_counts[voice_dirname] = counts

        for clip in clips:
            dest_base = clip_path(out_dir, voice_dirname,
                                  clip["category"], clip["stem"])

            # Special handling for hmm: the stem is "hmm" and there's no
            # subdirectory — it lives directly under voicedir/hmm.wav
            # We treat it as category="." stem="hmm" pattern; instead
            # the clip descriptor has category="hmm" stem="hmm" which means
            # out_dir/voice/hmm/hmm.wav — we want out_dir/voice/hmm.wav.
            # Re-map: if category == stem == "hmm", output is voicedir/hmm.*
            if clip["category"] == "hmm":
                dest_base = out_dir / voice_dirname / "hmm"

            skip, existing = should_skip(dest_base, args.force)
            if skip:
                ext = existing.suffix.lstrip(".")
                ext_seen.add(ext)
                counts["skip"] += 1
                print(f"  [skip]  {dest_base.relative_to(out_dir)}.{ext}")
                # Still record generated words.
                if clip["category"] == "words" and voice_dirname == primary_voice:
                    primary_words_generated.append(clip["stem"])
                continue

            voice_api = voices_map[voice_dirname]
            try:
                audio_bytes, ext = call_tts_api(
                    api, clip["prompt"], voice_api, model, api_key
                )
            except RuntimeError as exc:
                print(f"  [ERROR] {dest_base}: {exc}", file=sys.stderr)
                counts["err"] += 1
                continue

            dest = dest_base.with_suffix(f".{ext}")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(audio_bytes)
            n = len(audio_bytes)
            try:
                rel = dest.relative_to(out_dir)
            except ValueError:
                rel = dest
            print(f"  [ok]    {rel}  ({n} bytes)")
            counts["ok"] += 1
            counts["bytes"] += n
            ext_seen.add(ext)

            if clip["category"] == "words" and voice_dirname == primary_voice:
                primary_words_generated.append(clip["stem"])

            time.sleep(INTER_CALL_SLEEP)

        # Collect words from skipped primary clips too (order already correct).

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    print("\n── Summary ──────────────────────────────")
    total_bytes = 0
    for vname in requested_voices:
        c = voice_counts.get(vname, {})
        ok    = c.get("ok", 0)
        skip  = c.get("skip", 0)
        err   = c.get("err", 0)
        byt   = c.get("bytes", 0)
        total_bytes += byt
        print(f"  {vname:15s}  generated={ok}  skipped={skip}  errors={err}  "
              f"bytes={byt:,}")
    print(f"  {'TOTAL':15s}  bytes={total_bytes:,}")
    print()

    # ------------------------------------------------------------------
    # Write manifest (only if primary voice was in the run)
    # ------------------------------------------------------------------
    if primary_voice in requested_voices:
        # Determine dominant extension (prefer wav).
        if "wav" in ext_seen:
            dominant_ext = "wav"
        elif ext_seen:
            dominant_ext = sorted(ext_seen)[0]
        else:
            dominant_ext = "wav"

        # Preserve original word-list order for words actually generated.
        seen_words = set(primary_words_generated)
        ordered_words = [w for w in raw_words if w in seen_words]

        write_manifest(
            out_dir,
            primary_voice=primary_voice,
            voices_used=requested_voices,
            words_generated=ordered_words,
            ext_used=dominant_ext,
        )
    else:
        print("[manifest] Skipped (primary voice not in this run).")


if __name__ == "__main__":
    main()
