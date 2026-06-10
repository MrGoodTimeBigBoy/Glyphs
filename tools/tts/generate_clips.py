#!/usr/bin/env python3
"""
generate_clips.py — Glyphs Phase 2 TTS clip generator.

Generates short speech clips via the OpenRouter API using a Google Gemini
Flash TTS model and writes them under renderer/audio/ plus a generated
renderer/audio/manifest.js.

Standard library only: no pip install required.
Runs unchanged on macOS and Linux.

Usage:
    python3 tools/tts/generate_clips.py --probe
    python3 tools/tts/generate_clips.py
    python3 tools/tts/generate_clips.py --force
    python3 tools/tts/generate_clips.py --primary-only
    python3 tools/tts/generate_clips.py --model google/gemini-flash-tts-1
    python3 tools/tts/generate_clips.py --voices sulafat --force
"""

import argparse
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request
import wave

# ---------------------------------------------------------------------------
# Model configuration
# ---------------------------------------------------------------------------

# NOTE: This model ID is a best guess based on OpenRouter's naming convention
# for Google models. Confirm the exact ID against:
#     GET https://openrouter.ai/api/v1/models
# Filter for gemini + tts in the returned list and update this constant if
# needed before running a full clip generation pass.
DEFAULT_MODEL = "google/gemini-3.1-flash-tts-preview"

# Override via env var OPENROUTER_TTS_MODEL or --model flag.

# ---------------------------------------------------------------------------
# Voice configuration
# ---------------------------------------------------------------------------

# Primary voice used for the full word set.
PRIMARY_VOICE = "sulafat"

# Bake-off voices get only the subset below.
BAKEOFF_VOICES = ["aoede", "callirrhoe"]

# Map from directory name (lowercase) to the API voice string sent in the
# request body. Gemini prebuilt voice names may be case-sensitive.
# If the API returns errors about unrecognised voice names, adjust the values
# here — this is the single place to fix voice name casing.
VOICES = {
    "sulafat":     "Sulafat",
    "aoede":       "Aoede",
    "callirrhoe":  "Callirrhoe",
}

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
HTTP_REFERER    = "https://glyphs.local"
APP_TITLE       = "Glyphs"

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
        sample_rate:  Samples per second (default 24000 Hz, Gemini TTS default).
        channels:     Number of channels (default 1 = mono).
        sample_width: Bytes per sample (default 2 = 16-bit).

    Returns:
        Bytes of a valid WAV file readable by the stdlib `wave` module.
    """
    import io
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(sample_width)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()

# ---------------------------------------------------------------------------
# Audio extraction from API response
# ---------------------------------------------------------------------------

def extract_audio_bytes(response_json: dict) -> bytes:
    """Extract and decode audio bytes from an OpenRouter/Gemini TTS response.

    This function tries the known response shapes in priority order and returns
    the first one that yields non-empty bytes. If none match, raises RuntimeError
    with diagnostic information so the operator can identify which field to parse.

    Shapes tried (in order):
      1. choices[0].message.audio.data  — base64 string (OpenAI audio-output shape)
      2. choices[0].message.audio       — plain base64 string (flattened)
      3. choices[0].message.audio       — dict with "url" key (remote audio URL)
      4. output_audio.data              — top-level alternative key
      5. data                           — bare top-level base64 field
    """
    # -----------------------------------------------------------------------
    # Shape 1 & 2 & 3: OpenAI-compatible audio output
    # choices[0].message.audio can be:
    #   a dict  → {"data": "<base64>", "format": "wav", ...}
    #   a str   → "<base64>"
    #   a dict  → {"url": "<remote url>"}   (less common)
    # -----------------------------------------------------------------------
    choices = response_json.get("choices", [])
    if choices:
        message = choices[0].get("message", {})
        audio_field = message.get("audio")

        if audio_field is not None:
            # Shape 1: dict with "data" key
            if isinstance(audio_field, dict):
                data_b64 = audio_field.get("data")
                if data_b64:
                    raw = base64.b64decode(data_b64)
                    if raw:
                        return raw

                # Shape 3: dict with "url" key (download via urllib)
                url = audio_field.get("url")
                if url:
                    with urllib.request.urlopen(url) as resp:
                        return resp.read()

            # Shape 2: plain base64 string
            elif isinstance(audio_field, str) and audio_field:
                return base64.b64decode(audio_field)

    # -----------------------------------------------------------------------
    # Shape 4: output_audio top-level key
    # {"output_audio": {"data": "<base64>"}}
    # -----------------------------------------------------------------------
    output_audio = response_json.get("output_audio")
    if output_audio:
        if isinstance(output_audio, dict):
            data_b64 = output_audio.get("data")
            if data_b64:
                raw = base64.b64decode(data_b64)
                if raw:
                    return raw
        elif isinstance(output_audio, str) and output_audio:
            return base64.b64decode(output_audio)

    # -----------------------------------------------------------------------
    # Shape 5: bare top-level "data" field
    # {"data": "<base64>"}
    # -----------------------------------------------------------------------
    top_data = response_json.get("data")
    if top_data and isinstance(top_data, str):
        raw = base64.b64decode(top_data)
        if raw:
            return raw

    # Nothing found — dump keys for diagnostics.
    top_keys = list(response_json.keys())
    msg_keys: list = []
    if choices:
        msg_keys = list(choices[0].get("message", {}).keys())

    raise RuntimeError(
        "extract_audio_bytes: could not find audio data in response.\n"
        f"  Top-level keys seen: {top_keys}\n"
        f"  message keys seen:   {msg_keys}\n"
        "  Inspect the full response JSON and update extract_audio_bytes() "
        "with the correct field path."
    )

# ---------------------------------------------------------------------------
# API call
# ---------------------------------------------------------------------------

def call_tts_api(text: str, voice_api: str, model: str, api_key: str,
                 sample_rate: int = 24000) -> tuple[bytes, str]:
    """Call the OpenRouter TTS endpoint and return (audio_bytes, extension).

    Retries on HTTP 429/5xx or network errors with exponential backoff.

    Returns:
        Tuple of (audio_bytes, ext) where ext is "wav", "mp3", or "ogg".
        audio_bytes are ready to write to disk (WAV container or raw
        container bytes, not raw PCM).
    """
    payload = {
        "model": model,
        "modalities": ["text", "audio"],
        "audio": {
            "voice": voice_api,
            "format": "wav",
        },
        "messages": [
            {"role": "user", "content": text},
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Content-Type":   "application/json",
        "HTTP-Referer":   HTTP_REFERER,
        "X-Title":        APP_TITLE,
    }
    req = urllib.request.Request(OPENROUTER_CHAT, data=body,
                                 headers=headers, method="POST")

    last_exc = None
    for attempt in range(RETRY_ATTEMPTS):
        if attempt > 0:
            sleep_s = RETRY_BASE_SLEEP * (2 ** (attempt - 1))
            print(f"    [retry {attempt}/{RETRY_ATTEMPTS - 1}] sleeping {sleep_s:.0f}s …",
                  file=sys.stderr)
            time.sleep(sleep_s)

        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw_body = resp.read()
        except urllib.error.HTTPError as exc:
            status = exc.code
            if status in (429, 500, 502, 503, 504):
                last_exc = exc
                continue
            # Non-retryable HTTP error — read body for diagnostics and raise.
            err_body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(
                f"HTTP {status} from OpenRouter:\n{err_body}"
            ) from exc
        except OSError as exc:
            # Network-level error (connection refused, timeout, etc.)
            last_exc = exc
            continue

        # Parse response.
        try:
            response_json = json.loads(raw_body)
        except json.JSONDecodeError as exc:
            raise RuntimeError(
                f"OpenRouter returned non-JSON body:\n"
                f"{raw_body[:500].decode('utf-8', errors='replace')}"
            ) from exc

        # Extract audio data.
        audio_bytes = extract_audio_bytes(response_json)

        # Determine format.
        ext, is_container = detect_audio_format(audio_bytes)
        if not is_container:
            # Raw PCM — wrap in WAV container.
            audio_bytes = pcm_to_wav(audio_bytes, sample_rate=sample_rate)
            ext = "wav"

        return audio_bytes, ext

    raise RuntimeError(
        f"All {RETRY_ATTEMPTS} API attempts failed. Last error: {last_exc}"
    )

# ---------------------------------------------------------------------------
# Probe mode
# ---------------------------------------------------------------------------

def run_probe(model: str, api_key: str, out_dir: pathlib.Path,
              voice_dirname: str = PRIMARY_VOICE) -> None:
    """Generate ONE clip ('cat', primary voice) and print diagnostic info."""
    voice_api = VOICES.get(voice_dirname, voice_dirname.capitalize())
    prompt = f"{PROMPT_WORD} cat"
    print(f"\n[probe] model={model!r}  voice_dir={voice_dirname!r}"
          f"  voice_api={voice_api!r}")
    print(f"[probe] prompt: {prompt!r}")
    print(f"[probe] calling {OPENROUTER_CHAT} …")

    payload = {
        "model": model,
        "modalities": ["text", "audio"],
        "audio": {"voice": voice_api, "format": "wav"},
        "messages": [{"role": "user", "content": prompt}],
    }
    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Content-Type":   "application/json",
        "HTTP-Referer":   HTTP_REFERER,
        "X-Title":        APP_TITLE,
    }
    req = urllib.request.Request(OPENROUTER_CHAT, data=body,
                                 headers=headers, method="POST")

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw_body = resp.read()
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        print(f"[probe] HTTP {exc.code} error:\n{err_body}", file=sys.stderr)
        sys.exit(1)

    try:
        response_json = json.loads(raw_body)
    except json.JSONDecodeError:
        print(f"[probe] non-JSON response:\n{raw_body[:500]}", file=sys.stderr)
        sys.exit(1)

    # Print top-level keys.
    print(f"\n[probe] Top-level response keys: {list(response_json.keys())}")

    choices = response_json.get("choices", [])
    if choices:
        msg = choices[0].get("message", {})
        print(f"[probe] choices[0].message keys: {list(msg.keys())}")
        audio_field = msg.get("audio")
        if isinstance(audio_field, dict):
            print(f"[probe] choices[0].message.audio keys: {list(audio_field.keys())}")
        elif isinstance(audio_field, str):
            preview = audio_field[:40] + "…" if len(audio_field) > 40 else audio_field
            print(f"[probe] choices[0].message.audio (str, len={len(audio_field)}): {preview!r}")
    else:
        print("[probe] No 'choices' in response.")

    # Attempt extraction and report where data was found.
    try:
        audio_bytes = extract_audio_bytes(response_json)
        ext, is_container = detect_audio_format(audio_bytes)
        if is_container:
            print(f"\n[probe] Audio detected: container format={ext!r}  "
                  f"bytes={len(audio_bytes)}")
        else:
            wrapped = pcm_to_wav(audio_bytes)
            print(f"\n[probe] Audio detected: raw PCM → wrapping to WAV  "
                  f"pcm_bytes={len(audio_bytes)}  wav_bytes={len(wrapped)}")
            audio_bytes = wrapped
            ext = "wav"

        # Write the single probe clip.
        dest = out_dir / voice_dirname / "words" / f"cat.{ext}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(audio_bytes)
        print(f"[probe] Written: {dest}  ({len(audio_bytes)} bytes)")
    except RuntimeError as exc:
        print(f"\n[probe] extract_audio_bytes failed:\n{exc}", file=sys.stderr)
        print("\n[probe] Full response JSON (first 2000 chars):")
        print(json.dumps(response_json, indent=2)[:2000])
        sys.exit(1)

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
  primary: {json.dumps(PRIMARY_VOICE)},
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
            "Generate TTS audio clips for Glyphs via OpenRouter / "
            "Google Gemini Flash TTS. Reads OPENROUTER_API_KEY from env."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Confirm the API contract (generates one 'cat' clip, prints diagnostics):
  python3 tools/tts/generate_clips.py --probe

  # Full run (all voices, all clips):
  python3 tools/tts/generate_clips.py

  # Re-render everything for one voice only:
  python3 tools/tts/generate_clips.py --voices sulafat --force

  # Primary voice only, skip bake-off voices:
  python3 tools/tts/generate_clips.py --primary-only

  # Use a specific model ID:
  python3 tools/tts/generate_clips.py --model google/gemini-flash-tts-1
        """,
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
        "--force", action="store_true",
        help="Overwrite existing clips (default: skip non-empty existing files).",
    )
    parser.add_argument(
        "--model", default=None,
        help=(
            f"OpenRouter model ID (default: env OPENROUTER_TTS_MODEL, "
            f"or {DEFAULT_MODEL!r})."
        ),
    )
    parser.add_argument(
        "--voices", default=None,
        help=(
            "Comma-separated list of voice directory names to generate "
            "(e.g. sulafat,aoede). Default: all configured voices."
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

    # ------------------------------------------------------------------
    # Resolve model ID: --model > env > DEFAULT_MODEL
    # ------------------------------------------------------------------
    model = (
        args.model
        or os.environ.get("OPENROUTER_TTS_MODEL")
        or DEFAULT_MODEL
    )

    # ------------------------------------------------------------------
    # API key check — MUST happen before ANY network call.
    # ------------------------------------------------------------------
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        print(
            "ERROR: OPENROUTER_API_KEY environment variable is not set.\n"
            "Export it before running:\n"
            "  export OPENROUTER_API_KEY=sk-or-v1-...\n"
            "Get a key at https://openrouter.ai/settings/keys",
            file=sys.stderr,
        )
        sys.exit(1)

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
    if args.voices:
        requested_voices = [v.strip().lower() for v in args.voices.split(",")]
    elif args.primary_only:
        requested_voices = [PRIMARY_VOICE]
    else:
        requested_voices = [PRIMARY_VOICE] + BAKEOFF_VOICES

    # Validate voices.
    unknown = [v for v in requested_voices if v not in VOICES]
    if unknown:
        print(
            f"ERROR: unknown voice(s): {unknown}. "
            f"Configured voices: {list(VOICES.keys())}",
            file=sys.stderr,
        )
        sys.exit(1)

    # ------------------------------------------------------------------
    # Probe mode
    # ------------------------------------------------------------------
    if args.probe:
        print(f"[probe] model: {model}")
        print(f"[probe] out_dir: {out_dir}")
        run_probe(model, api_key, out_dir, voice_dirname=PRIMARY_VOICE)
        print("\n[probe] Done. Inspect the output above, then run without "
              "--probe for the full clip set.")
        return

    # ------------------------------------------------------------------
    # Full run
    # ------------------------------------------------------------------
    print(f"\nGlyphs TTS clip generator")
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
        is_bakeoff = (voice_dirname != PRIMARY_VOICE) and (voice_dirname in BAKEOFF_VOICES)
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
                if clip["category"] == "words" and voice_dirname == PRIMARY_VOICE:
                    primary_words_generated.append(clip["stem"])
                continue

            voice_api = VOICES.get(voice_dirname, voice_dirname.capitalize())
            try:
                audio_bytes, ext = call_tts_api(
                    clip["prompt"], voice_api, model, api_key
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

            if clip["category"] == "words" and voice_dirname == PRIMARY_VOICE:
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
    if PRIMARY_VOICE in requested_voices:
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
            voices_used=requested_voices,
            words_generated=ordered_words,
            ext_used=dominant_ext,
        )
    else:
        print("[manifest] Skipped (primary voice not in this run).")


if __name__ == "__main__":
    main()
