#!/usr/bin/env python3
"""
generate_clips.py — Glyphs Phase 2 TTS clip generator.

Generates short speech clips with Google Gemini Flash TTS and writes them
under renderer/audio/ plus a generated renderer/audio/manifest.js.

Two API backends (--api), same model family and the same voices
(Sulafat / Aoede / Callirrhoe) on both:

  openrouter  POST https://openrouter.ai/api/v1/audio/speech
              The plan-of-record route. NOTE (verified 2026-06-10): TTS
              models are served by this dedicated OpenAI-TTS-shaped
              endpoint and are HIDDEN from the public GET /api/v1/models
              list (their output modality is "speech"); chat/completions
              rejects them. Confirm a TTS model id via
              GET /api/v1/models/{id}/endpoints (or --list-models here).
              Response is raw PCM (rate/channels in the Content-Type
              header) or MP3; we request PCM and wrap it into WAV.

  gemini      POST https://generativelanguage.googleapis.com/v1beta/
                   models/{model}:generateContent
              Google's Gemini API direct — the documented fallback should
              the OpenRouter route disappear. Requires GEMINI_API_KEY
              (or GOOGLE_API_KEY).

Standard library only: no pip install required.
Runs unchanged on macOS and Linux.

Usage:
    python3 tools/tts/generate_clips.py --probe
    python3 tools/tts/generate_clips.py --list-models
    python3 tools/tts/generate_clips.py
    python3 tools/tts/generate_clips.py --force
    python3 tools/tts/generate_clips.py --primary-only
    python3 tools/tts/generate_clips.py --voices sulafat --force
    python3 tools/tts/generate_clips.py --api gemini --probe
"""
from __future__ import annotations

import argparse
import array
import base64
import io
import json
import math
import os
import pathlib
import re
import struct
import sys
import time
import urllib.error
import urllib.request
import wave

# ---------------------------------------------------------------------------
# API / model configuration
# ---------------------------------------------------------------------------

API_CONFIGS = {
    "openrouter": {
        # Confirmed live 2026-06-10 (provider: Google Vertex) via
        # /api/v1/models/google/gemini-3.1-flash-tts-preview/endpoints.
        "default_model": "google/gemini-3.1-flash-tts-preview",
        "model_env":     "OPENROUTER_TTS_MODEL",
        "key_env":       ["OPENROUTER_API_KEY"],
    },
    "gemini": {
        # Best guess for the direct-API id; confirm with
        #     python3 tools/tts/generate_clips.py --api gemini --list-models
        # and override via --model or the env var if it has moved on.
        "default_model": "gemini-2.5-flash-preview-tts",
        "model_env":     "GEMINI_TTS_MODEL",
        "key_env":       ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    },
}

DEFAULT_API = "openrouter"

# ---------------------------------------------------------------------------
# Voice configuration (shared by both backends — Gemini prebuilt voices)
# ---------------------------------------------------------------------------

# Primary voice used for the full word set.
# Gate decision (Ian, 2026-06-10 listening session): Callirrhoe won the
# bake-off.
PRIMARY_VOICE = "callirrhoe"

# Former bake-off voices, kept at subset size so the harness can still
# A/B warmth against the winner while delivery is being iterated.
BAKEOFF_VOICES = ["sulafat", "aoede"]

# Map from directory name (lowercase) to the API voice string sent in the
# request body. All three verified accepted with this casing (2026-06-10).
VOICES = {
    "sulafat":     "Sulafat",
    "aoede":       "Aoede",
    "callirrhoe":  "Callirrhoe",
}

# Words and special tokens that make up the bake-off subset.
BAKEOFF_WORDS = ["cat", "sun", "apple", "the", "run"]
BAKEOFF_LETTERS = ["c", "a", "t"]  # phonemic only
BAKEOFF_HMM = True
BAKEOFF_DEFLATE = True

# ---------------------------------------------------------------------------
# Style prompts
# ---------------------------------------------------------------------------

# Base storyteller style applied to every word clip, with an optional
# per-word delivery hint spliced in between prefix and suffix.
STYLE_PREFIX = (
    "Read this aloud in a clear, warm, friendly voice, like a gentle "
    "storyteller reading to a young child."
)
STYLE_SUFFIX = "Natural and unhurried:"

# Per-word delivery hints (gate feedback: one uniform delivery across all
# twenty words felt repetitive; the animals "wanted to be more active").
# Words not listed get the plain storyteller delivery. Iterate by ear —
# edit a hint, then re-render that word with:
#   python3 tools/tts/generate_clips.py --voices callirrhoe --force
WORD_STYLES = {
    "cat":   "Playful and lively, as if the cat just pounced.",
    "dog":   "Upbeat and eager, with a smile.",
    "bird":  "Light and bright, almost chirpy.",
    "fish":  "Bubbly and amused.",
    "run":   "Quick and energetic, like an invitation to play chase.",
    "go":    "Encouraging and eager, ready to set off.",
    "sun":   "Bright and delighted, like greeting a sunny morning.",
    "moon":  "Soft and dreamy, a whisper of wonder.",
    "star":  "Hushed wonder, like making a wish.",
    "tree":  "Calm and steady, full of quiet awe.",
    "rain":  "Gentle and soothing, like watching drops on a window.",
    "apple": "Cheerful and crisp.",
    # "slow" + the feeling-category hint made the model trail off into
    # silence (empty body from the API, every attempt 2026-06-10) —
    # pin a delivery that stays audible.
    "slow":  "Easygoing and warm, gently stretching the word out.",
    "mom":   "Extra loving and tender.",
    "dad":   "Warm and proud.",
    # the, and, see, like, you, me — plain storyteller delivery.
}

# Category-level delivery hints for the Phase 3 bundle (wordlist.txt's
# optional second column picks one). Written in the voice of the
# gate-accepted WORD_STYLES entries — one short sentence each. A word's
# WORD_STYLES entry, if present, overrides its category hint; words with
# neither get the plain storyteller read.
CATEGORY_STYLES = {
    "action":    "Quick and energetic, like an invitation to play.",
    "animal":    "Playful and lively, with a smile.",
    "body":      "Friendly and playful, like a game of peek-a-boo.",
    "celestial": "Hushed wonder, soft and dreamy.",
    "color":     "Bright and vivid.",
    "family":    "Extra warm and loving.",
    "feeling":   "Expressive — let the word's feeling color the voice.",
    "food":      "Cheerful and appetizing.",
    "home":      "Cozy and familiar.",
    "magic":     "A twinkle of mystery and delight.",
    "nature":    "Calm and fresh, full of quiet awe.",
    "number":    "Clear and bouncy, like counting out a game.",
    "place":     "Inviting and curious, like setting off somewhere fun.",
    "vehicle":   "Energetic and full of motion, zooming past.",
    "weather":   "Gentle and atmospheric, like watching it through a window.",
}

def word_prompt(word: str, category: str | None = None) -> str:
    """Build the TTS prompt for a word clip.

    The delivery hint resolves WORD_STYLES[word] (individual override) →
    CATEGORY_STYLES[category] (wordlist column 2) → none (plain
    storyteller read).

    The word is QUOTED in the prompt. Bare short/function words after the
    colon make the model return empty audio ("and", "go", "me", …) or read
    the instruction itself aloud for ~20s ("the") — verified 2026-06-10;
    quoting pins the content and fixed every case.
    """
    hint = WORD_STYLES.get(word)
    if hint is None and category is not None:
        hint = CATEGORY_STYLES.get(category)
    middle = f" {hint} " if hint else " "
    return f'{STYLE_PREFIX}{middle}{STYLE_SUFFIX} "{word}"'

PROMPT_PHONEMIC = (
    "Say only this letter sound, clearly and warmly, the way you sound out "
    "a letter for a young child (do not say the letter's name):"
)

PROMPT_LETTER_NAME = "Say the name of this letter, clearly and warmly:"

PROMPT_HMM = (
    "Say a soft, thoughtful 'hmm', warm and curious, as if gently wondering:"
)

PROMPT_DEFLATE = (
    "Make a soft, breathy, deflating 'pfff' sound, gentle and amused, like "
    "a little balloon letting its air out — friendly, never harsh:"
)

# ---------------------------------------------------------------------------
# Phonemic and letter-name spellings
# ---------------------------------------------------------------------------

# Text fed to TTS for each letter's phonemic/short sound.
# "r" is spelled "rrr" — the original "rr" came out as "ooo" (gate
# feedback). If another letter sounds wrong, fix its spelling here and
# re-render with --voices callirrhoe --force.
PHONEMIC_MAP = {
    "a": "ah", "b": "buh", "c": "kuh", "d": "duh", "e": "eh",
    "f": "ff",  "g": "guh", "h": "huh", "i": "ih",  "j": "juh",
    "k": "kuh", "l": "ll",  "m": "mm",  "n": "nn",  "o": "aw",
    "p": "puh", "q": "kwuh","r": "rrr", "s": "ss",  "t": "tuh",
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
# ARPABET phoneme spellings for the 39 phonemes of American English
# ---------------------------------------------------------------------------

# Text fed to TTS for each ARPABET phoneme's isolated sound.
#
# Like PHONEMIC_MAP, these spellings are first-pass approximations that get
# iterated by ear after the first render.  If a phoneme sounds wrong, fix
# its spelling here and re-render with:
#     python3 tools/tts/generate_clips.py --voices callirrhoe --force
#
# Spelling philosophy:
#   - Vowels: the natural English spelling of the vowel sound is usually
#     right, sometimes lengthened (e.g. "aaa") to prevent over-shortening.
#   - Stops (B D G K P T): English stops inherently release with a tiny
#     schwa; we aim for the minimal "consonant + uh" burst using "buh",
#     "duh", etc.  A light schwa release is unavoidable and acceptable.
#   - Fricatives/affricates: spelled as close to the pure sound as possible.
#   - Nasals/liquids/glides: extended spelling to hold the target articulation.
#
# Prompt text below disambiguates where the spelling alone is ambiguous
# (e.g. "th" is both voiced and unvoiced; "ng" could read as n+g).
PHONEME_MAP = {
    # --- Vowels ---
    # AA: "ah" as in "father"  (open back unrounded)
    "AA": ("aah", "the vowel sound 'ah' as in 'father', just the sound"),
    # AE: "a" as in "cat"  (near-open front unrounded)
    "AE": ("aaa", "the vowel sound 'a' as in 'cat', just the sound"),
    # AH: reduced schwa / "uh" as in "about"  (mid central)
    "AH": ("uh", "the short vowel sound 'uh' as in 'about', just the sound"),
    # AO: "aw" as in "thought"  (open-mid back rounded)
    "AO": ("aw", "the vowel sound 'aw' as in 'thought', just the sound"),
    # AW: "ow" diphthong as in "cow"  (AO+W glide)
    "AW": ("ow", "the vowel sound 'ow' as in 'cow', just the sound"),
    # AY: "eye" diphthong as in "sky"  (AA+Y glide)
    "AY": ("eye", "the vowel sound 'eye' as in 'sky', just the sound"),
    # EH: "e" as in "bed"  (open-mid front unrounded)
    "EH": ("ehh", "the vowel sound 'e' as in 'bed', just the sound"),
    # ER: r-colored vowel as in "bird"  (r-colored mid central)
    "ER": ("errr", "the vowel sound 'er' as in 'bird', just the sound"),
    # EY: "ay" diphthong as in "say"  (EH+Y glide)
    "EY": ("ayy", "the vowel sound 'ay' as in 'say', just the sound"),
    # IH: "i" as in "bit"  (near-close near-front unrounded)
    "IH": ("ih", "the short vowel sound 'i' as in 'bit', just the sound"),
    # IY: "ee" as in "see"  (close front unrounded)
    "IY": ("eee", "the vowel sound 'ee' as in 'see', just the sound"),
    # OW: "oh" diphthong as in "go"  (OW glide)
    "OW": ("ohh", "the vowel sound 'oh' as in 'go', just the sound"),
    # OY: "oy" diphthong as in "boy"  (AO+Y glide)
    "OY": ("oy", "the vowel sound 'oy' as in 'boy', just the sound"),
    # UH: "oo" as in "book"  (near-close near-back rounded)
    "UH": ("ooh", "the vowel sound 'oo' as in 'book', just the sound"),
    # UW: "oo" as in "cool"  (close back rounded)
    "UW": ("oooh", "the vowel sound 'oo' as in 'cool', just the sound"),

    # --- Stops ---
    # B: voiced bilabial stop
    "B":  ("buh", "the consonant sound 'b' as in 'bat', just the sound, a light burst"),
    # D: voiced alveolar stop
    "D":  ("duh", "the consonant sound 'd' as in 'dog', just the sound, a light burst"),
    # G: voiced velar stop
    "G":  ("guh", "the consonant sound 'g' as in 'go', just the sound, a light burst"),
    # K: voiceless velar stop
    "K":  ("kuh", "the consonant sound 'k' as in 'cat', just the sound, a light burst"),
    # P: voiceless bilabial stop
    "P":  ("puh", "the consonant sound 'p' as in 'pat', just the sound, a light burst"),
    # T: voiceless alveolar stop
    "T":  ("tuh", "the consonant sound 't' as in 'top', just the sound, a light burst"),

    # --- Affricates ---
    # CH: voiceless postalveolar affricate, as in "church"
    "CH": ("ch", "the sound 'ch' as in 'church', just the sound"),
    # JH: voiced postalveolar affricate, as in "jump"
    "JH": ("juh", "the sound 'j' as in 'jump', just the sound"),

    # --- Fricatives ---
    # DH: voiced dental fricative, as in "the" (NOT unvoiced "th" as in "think")
    "DH": ("th", "the voiced 'th' sound as in 'the' or 'this', just the sound (voiced, not as in 'think')"),
    # F: voiceless labiodental fricative
    "F":  ("fff", "the consonant sound 'f' as in 'fan', just the sound"),
    # HH: voiceless glottal fricative, as in "hat"
    "HH": ("huh", "the consonant sound 'h' as in 'hat', just a breath burst"),
    # S: voiceless alveolar fricative
    "S":  ("sss", "the consonant sound 's' as in 'sun', just the hissing sound"),
    # SH: voiceless postalveolar fricative, as in "ship"
    "SH": ("shh", "the sound 'sh' as in 'ship', just the sound"),
    # TH: voiceless dental fricative, as in "think" (NOT voiced "th" as in "the")
    "TH": ("th", "the unvoiced 'th' sound as in 'think' or 'thin', just the sound (unvoiced, not as in 'the')"),
    # V: voiced labiodental fricative
    "V":  ("vvv", "the consonant sound 'v' as in 'van', just the sound"),
    # Z: voiced alveolar fricative
    "Z":  ("zzz", "the consonant sound 'z' as in 'zoo', just the buzzing sound"),
    # ZH: voiced postalveolar fricative, as in "measure"
    "ZH": ("zh", "the sound 'zh' as in 'measure' or 'vision', just the sound"),

    # --- Nasals ---
    # M: voiced bilabial nasal
    "M":  ("mmm", "the consonant sound 'm' as in 'man', just the nasal hum"),
    # N: voiced alveolar nasal
    "N":  ("nnn", "the consonant sound 'n' as in 'no', just the nasal sound"),
    # NG: voiced velar nasal, as in "sing" (NOT n+g; the ng at the end of 'sing')
    "NG": ("ng", "the nasal sound 'ng' as in 'sing' or 'ring', just the sound (not n+g)"),

    # --- Liquids ---
    # L: voiced alveolar lateral approximant
    "L":  ("lll", "the consonant sound 'l' as in 'lip', just the sound"),
    # R: voiced alveolar approximant
    "R":  ("rrr", "the consonant sound 'r' as in 'run', just the sound"),

    # --- Glides ---
    # W: voiced labial-velar approximant
    "W":  ("wuh", "the consonant sound 'w' as in 'win', just the sound"),
    # Y: voiced palatal approximant
    "Y":  ("yuh", "the consonant sound 'y' as in 'yes', just the sound"),
}

# The ordered list of all 39 ARPABET phonemes for the American English set.
PHONEME_SYMBOLS = [
    "AA", "AE", "AH", "AO", "AW", "AY",
    "B",  "CH", "D",  "DH", "EH", "ER",
    "EY", "F",  "G",  "HH", "IH", "IY",
    "JH", "K",  "L",  "M",  "N",  "NG",
    "OW", "OY", "P",  "R",  "S",  "SH",
    "T",  "TH", "UH", "UW", "V",  "W",
    "Y",  "Z",  "ZH",
]

# Prompt for phoneme clips: the model must produce ONLY the isolated sound,
# not a letter name or word.
PROMPT_PHONEME = (
    "Say only this isolated phoneme sound, clearly, the way a speech therapist "
    "demonstrates a single sound for a child — no leading words, no explanation, "
    "just the sound itself. The phoneme:"
)

# ---------------------------------------------------------------------------
# Phoneme post-processing constants
# (These are the critical conditioning knobs for concatenation quality —
#  small changes here cascade into how every G2P-decomposed word sounds.)
# ---------------------------------------------------------------------------

# Energy threshold (0–32767 ≈ 16-bit full-scale) below which a sample is
# considered "silence" for the purpose of leading/trailing trim.
PHONEME_ENERGY_THRESHOLD = 200

# Silence to preserve at the very start of a trimmed phoneme clip (ms).
# A little headroom prevents clicks at the attack of stops/affricates.
PHONEME_HEAD_PAD_MS = 10

# Silence to preserve at the end of a trimmed phoneme clip (ms).
# Long enough for the last resonance of nasals/liquids to decay naturally.
PHONEME_TAIL_PAD_MS = 30

# Fade-in at the start of a phoneme clip (ms).
# Kills any click that survives the head-pad trim.
PHONEME_FADE_IN_MS = 5

# Fade-out at the end of a phoneme clip (ms).
# Kills the tail click without smearing the final formant.
PHONEME_FADE_OUT_MS = 25

# RMS normalisation target for phoneme clips (0–1 as a fraction of full-scale).
# Chosen so that concatenated phoneme sequences match the loudness of word
# clips — ear-tune this alongside the gap constants in audio.js.
PHONEME_RMS_TARGET = 0.08

# ---------------------------------------------------------------------------
# API constants
# ---------------------------------------------------------------------------

OPENROUTER_BASE   = "https://openrouter.ai/api/v1"
OPENROUTER_SPEECH = f"{OPENROUTER_BASE}/audio/speech"
OPENROUTER_MODELS = f"{OPENROUTER_BASE}/models"
HTTP_REFERER      = "https://glyphs.local"
APP_TITLE         = "Glyphs"

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

# Tail conditioning: several raw clips end on a hot sample, which plays as
# an audible click / cut-off (gate feedback). Fade the tail to zero and pad
# with a touch of silence before wrapping into WAV.
FADE_OUT_MS = 40
TAIL_PAD_MS = 80

def condition_tail(pcm_bytes: bytes, sample_rate: int,
                   channels: int = 1) -> bytes:
    """Apply a half-cosine fade over the last FADE_OUT_MS of s16le PCM and
    append TAIL_PAD_MS of silence."""
    samples = array.array("h")
    samples.frombytes(pcm_bytes[: (len(pcm_bytes) // 2) * 2])
    n_fade = min(len(samples),
                 int(sample_rate * channels * FADE_OUT_MS / 1000))
    start = len(samples) - n_fade
    for j in range(n_fade):
        gain = 0.5 * (1.0 + math.cos(math.pi * (j + 1) / n_fade))
        samples[start + j] = int(samples[start + j] * gain)
    samples.extend([0] * int(sample_rate * channels * TAIL_PAD_MS / 1000))
    return samples.tobytes()

def finalize_audio(raw: bytes, sample_rate: int = 24000,
                   channels: int = 1) -> tuple[bytes, str]:
    """Turn raw API audio bytes into writable file bytes + extension.

    Container formats (detected by magic bytes) pass through verbatim —
    no tail conditioning. Bare PCM gets its tail conditioned, then is
    wrapped in a WAV header at the given rate/channels.
    """
    ext, is_container = detect_audio_format(raw)
    if not is_container:
        conditioned = condition_tail(raw, sample_rate, channels)
        return pcm_to_wav(conditioned, sample_rate=sample_rate,
                          channels=channels), "wav"
    return raw, ext


def condition_phoneme(wav_bytes: bytes) -> bytes:
    """Post-process a phoneme WAV clip for concatenation quality.

    Applied after the standard tail conditioning (which is still run via
    finalize_audio before this function is called on the resulting WAV).
    Steps:
      1. Decode WAV to s16le samples (stdlib wave only — no audioop).
      2. Trim leading and trailing silence below PHONEME_ENERGY_THRESHOLD,
         keeping PHONEME_HEAD_PAD_MS / PHONEME_TAIL_PAD_MS of silence at
         each end.
      3. Short fade-in (PHONEME_FADE_IN_MS) and fade-out (PHONEME_FADE_OUT_MS)
         to kill any residual click at the splice points.
      4. RMS-normalise to PHONEME_RMS_TARGET so no phoneme jumps out of a
         concatenated sequence.

    Operates on the 16-bit PCM with stdlib only (wave + array + struct).
    audioop is intentionally avoided — it may be absent on Python 3.13+.
    """
    # --- 1. Decode WAV ---
    buf = io.BytesIO(wav_bytes)
    with wave.open(buf, "rb") as wf:
        rate     = wf.getframerate()
        channels = wf.getnchannels()
        width    = wf.getsampwidth()
        n_frames = wf.getnframes()
        raw_pcm  = wf.readframes(n_frames)

    # Parse s16le samples; work in mono (channels == 1 guaranteed for our
    # pipeline, but handle multi-channel gracefully by summing to mono).
    n_samples_total = len(raw_pcm) // 2
    all_samples = array.array("h")
    all_samples.frombytes(raw_pcm[: n_samples_total * 2])

    if channels > 1:
        # Average channels into mono.
        mono = array.array("h")
        for i in range(0, len(all_samples), channels):
            s = sum(all_samples[i + c] for c in range(channels)) // channels
            mono.append(max(-32768, min(32767, s)))
        samples = mono
        channels = 1
    else:
        samples = all_samples

    n = len(samples)
    if n == 0:
        return wav_bytes   # nothing to process

    # --- 2. Trim leading silence ---
    head_pad_samples = int(rate * PHONEME_HEAD_PAD_MS / 1000)
    tail_pad_samples = int(rate * PHONEME_TAIL_PAD_MS / 1000)

    # Find first sample above threshold.
    first_loud = 0
    for i in range(n):
        if abs(samples[i]) > PHONEME_ENERGY_THRESHOLD:
            first_loud = i
            break

    # Find last sample above threshold.
    last_loud = n - 1
    for i in range(n - 1, -1, -1):
        if abs(samples[i]) > PHONEME_ENERGY_THRESHOLD:
            last_loud = i
            break

    start = max(0, first_loud - head_pad_samples)
    end   = min(n, last_loud + tail_pad_samples + 1)
    samples = array.array("h", samples[start:end])
    n = len(samples)

    if n == 0:
        return wav_bytes   # clip was entirely silence — return original

    # --- 3. Fade in and fade out ---
    n_fade_in  = min(n, int(rate * PHONEME_FADE_IN_MS  / 1000))
    n_fade_out = min(n, int(rate * PHONEME_FADE_OUT_MS / 1000))

    for j in range(n_fade_in):
        gain = j / n_fade_in    # linear ramp 0 → 1
        samples[j] = int(samples[j] * gain)

    for j in range(n_fade_out):
        gain = (n_fade_out - j) / n_fade_out    # linear ramp 1 → 0
        samples[n - n_fade_out + j] = int(samples[n - n_fade_out + j] * gain)

    # --- 4. RMS normalise ---
    sum_sq = sum(s * s for s in samples)
    rms = math.sqrt(sum_sq / n) if n > 0 else 0.0
    if rms > 0:
        target_rms = PHONEME_RMS_TARGET * 32767.0
        gain = target_rms / rms
        # Cap so we never amplify completely silent or near-silent clips to
        # a damaging level — max 8× gain.
        gain = min(gain, 8.0)
        for i in range(n):
            samples[i] = max(-32768, min(32767, int(samples[i] * gain)))

    return pcm_to_wav(samples.tobytes(), sample_rate=rate, channels=channels)

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
# OpenRouter backend — dedicated TTS endpoint /api/v1/audio/speech
# ---------------------------------------------------------------------------

def openrouter_request(text: str, voice_api: str, model: str,
                       api_key: str) -> urllib.request.Request:
    """Build the audio/speech request for OpenRouter.

    The endpoint accepts response_format "mp3" or "pcm" only; we take PCM
    and wrap it into WAV ourselves (rate/channels come back in the
    Content-Type header, e.g. "audio/pcm;rate=24000;channels=1").
    """
    payload = {
        "model": model,
        "input": text,
        "voice": voice_api,
        "response_format": "pcm",
    }
    headers = {
        "Authorization":  f"Bearer {api_key}",
        "Content-Type":   "application/json",
        "HTTP-Referer":   HTTP_REFERER,
        "X-Title":        APP_TITLE,
    }
    return urllib.request.Request(OPENROUTER_SPEECH,
                                  data=json.dumps(payload).encode("utf-8"),
                                  headers=headers, method="POST")

def parse_pcm_content_type(content_type: str) -> tuple[int, int]:
    """Extract (sample_rate, channels) from an audio Content-Type header.

    Defaults to (24000, 1) when the header carries no parameters.
    """
    rate_match = re.search(r"rate=(\d+)", content_type or "")
    chan_match = re.search(r"channels=(\d+)", content_type or "")
    rate = int(rate_match.group(1)) if rate_match else 24000
    channels = int(chan_match.group(1)) if chan_match else 1
    return rate, channels

def call_tts_openrouter(text: str, voice_api: str, model: str,
                        api_key: str) -> tuple[bytes, str]:
    """Generate one clip via OpenRouter; return (file_bytes, extension)."""
    raw, content_type = http_with_retry(
        lambda: openrouter_request(text, voice_api, model, api_key),
        lambda resp: (resp.read(), resp.headers.get("Content-Type", "")),
    )
    if not raw:
        raise RuntimeError(
            f"OpenRouter audio/speech returned an empty body "
            f"(Content-Type: {content_type!r})."
        )
    rate, channels = parse_pcm_content_type(content_type)
    return finalize_audio(raw, sample_rate=rate, channels=channels)

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

def keychain_api_key(service: str) -> str | None:
    """Read an API key from the macOS Keychain (returns None off-macOS,
    when the item is absent, or when access is denied).

    Store the key once, outside any repo, with:
        security add-generic-password -a "$USER" -s SERVICE_NAME -w 'the-key' -U
    """
    if sys.platform != "darwin":
        return None
    import subprocess
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", service, "-w"],
            capture_output=True, text=True, timeout=10,
        )
    except Exception:
        return None
    key = out.stdout.strip()
    return key if out.returncode == 0 and key else None

def resolve_api_key(api: str) -> str:
    """Read the backend's API key from the environment or the macOS
    Keychain (service name == env var name), or exit with help."""
    env_names = API_CONFIGS[api]["key_env"]
    for name in env_names:
        key = os.environ.get(name)
        if key:
            return key
    for name in env_names:
        key = keychain_api_key(name)
        if key:
            return key
    hint = {
        "openrouter": "Get a key at https://openrouter.ai/settings/keys",
        "gemini":     "Get a key at https://aistudio.google.com/apikey",
    }[api]
    print(
        f"ERROR: no API key set for --api {api}.\n"
        f"Export one of: {', '.join(env_names)} — or store it in the macOS\n"
        f"Keychain: security add-generic-password -a \"$USER\" "
        f"-s {env_names[0]} -w 'the-key' -U\n{hint}",
        file=sys.stderr,
    )
    sys.exit(1)

# ---------------------------------------------------------------------------
# Model listing (--list-models)
# ---------------------------------------------------------------------------

def list_models(api: str, api_key: str | None, model: str) -> None:
    """Print TTS-model availability for the selected backend."""
    if api == "openrouter":
        # TTS ("speech"-output) models are hidden from the public models
        # list, so check the configured model's endpoints directly.
        # Both endpoints are public — no key required.
        req = urllib.request.Request(f"{OPENROUTER_MODELS}/{model}/endpoints")
        print(f"[models] endpoint check for {model!r}:")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read()).get("data", {})
            arch = data.get("architecture") or {}
            print(f"  name:      {data.get('name')}")
            print(f"  modality:  {arch.get('modality')}")
            for ep in data.get("endpoints", []):
                print(f"  endpoint:  provider={ep.get('provider_name')}  "
                      f"status={ep.get('status')}  "
                      f"uptime_1d={ep.get('uptime_last_1d')}")
            if not data.get("endpoints"):
                print("  NO ENDPOINTS — the model is not currently routable.")
        except urllib.error.HTTPError as exc:
            print(f"  HTTP {exc.code} — unknown model id?")

        req = urllib.request.Request(OPENROUTER_MODELS)
        with urllib.request.urlopen(req, timeout=60) as resp:
            models = json.loads(resp.read()).get("data", [])
        print(f"\n[models] public list ({len(models)} models) — audio-output "
              f"and tts-named entries (NOTE: dedicated TTS models usually "
              f"do NOT appear here):")
        found = False
        for m in models:
            arch = m.get("architecture") or {}
            if ("audio" in (arch.get("output_modalities") or [])
                    or "tts" in m.get("id", "").lower()):
                print(f"  {m.get('id')}  out={arch.get('output_modalities')}")
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
    prompt = word_prompt("cat")
    print(f"\n[probe] api={api}  model={model!r}  voice_dir={voice_dirname!r}"
          f"  voice_api={voice_api!r}")
    print(f"[probe] prompt: {prompt!r}")

    if api == "openrouter":
        print(f"[probe] calling {OPENROUTER_SPEECH} …")
        try:
            with urllib.request.urlopen(
                openrouter_request(prompt, voice_api, model, api_key),
                timeout=120,
            ) as resp:
                raw = resp.read()
                content_type = resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            err_body = exc.read().decode("utf-8", errors="replace")
            print(f"[probe] HTTP {exc.code} error:\n{err_body}", file=sys.stderr)
            sys.exit(1)
        print(f"\n[probe] Content-Type: {content_type}")
        print(f"[probe] body: {len(raw)} bytes, magic={raw[:4]!r}")
        if not raw:
            print("\n[probe] Empty body — inspect the headers above.",
                  file=sys.stderr)
            sys.exit(1)
        rate, channels = parse_pcm_content_type(content_type)
        audio_bytes, ext = finalize_audio(raw, sample_rate=rate,
                                          channels=channels)
        if ext == "wav" and raw[:4] != MAGIC_RIFF:
            secs = len(raw) / (rate * channels * 2)
            print(f"[probe] raw PCM {rate} Hz ×{channels}ch → WAV, "
                  f"{secs:.2f}s ({len(audio_bytes)} bytes)")
        else:
            print(f"[probe] container format .{ext} ({len(audio_bytes)} bytes)")
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
# Word list parsing
# ---------------------------------------------------------------------------

def parse_wordlist(words_file: pathlib.Path) -> tuple[list[str], dict[str, str]]:
    """Parse the word list file into (words, word→category map).

    Format — one entry per line, whitespace-separated:
        word [category]
    Blank lines and lines starting with '#' are ignored, so the file can
    carry reviewable section headers. Token 0 is the word (file order is
    manifest order); token 1, when present, names a CATEGORY_STYLES
    delivery hint. No category → plain storyteller read (or the word's
    own WORD_STYLES entry, which always wins).
    """
    words: list[str] = []
    categories: dict[str, str] = {}
    for line in words_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        tokens = line.split()
        word = tokens[0]
        words.append(word)
        if len(tokens) > 1:
            categories[word] = tokens[1]
    return words, categories

# ---------------------------------------------------------------------------
# Build clip list for a voice
# ---------------------------------------------------------------------------

def clips_for_voice(words: list[str], categories: dict[str, str],
                    voice_dirname: str, is_bakeoff: bool) -> list[dict]:
    """Return a list of clip descriptors for a given voice.

    Each descriptor is a dict:
        {"category": str, "stem": str, "prompt": str}

    Args:
        words:        Full word list.
        categories:   Word → delivery-category map (CATEGORY_STYLES keys).
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
            "prompt": word_prompt(word, categories.get(word)),
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

    # Phonemes — 39 ARPABET phonemes of American English (primary voice only;
    # bake-off voices do not need phoneme clips — they are not used for G2P).
    if not is_bakeoff:
        for ph in PHONEME_SYMBOLS:
            spelling, context = PHONEME_MAP[ph]
            clips.append({
                "category": "phonemes",
                "stem": ph.lower(),
                "prompt": f"{PROMPT_PHONEME} {context}. Sound: {spelling}",
                "post_process": "phoneme",
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

    # deflate (junk input — DESIGN.md: no failure states, keep it friendly)
    if is_bakeoff and not BAKEOFF_DEFLATE:
        pass
    else:
        clips.append({
            "category": "deflate",
            "stem": "deflate",
            "prompt": f"{PROMPT_DEFLATE} pfff",
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
    phonemes_js      = json.dumps([ph.lower() for ph in PHONEME_SYMBOLS])

    content = f"""\
/* GENERATED by tools/tts/generate_clips.py — do not edit by hand. */
window.Glyphs = window.Glyphs || {{}};
window.Glyphs.audio = window.Glyphs.audio || {{}};
window.Glyphs.audio.manifest = {{
  primary: {json.dumps(PRIMARY_VOICE)},
  voices: {voices_js},
  ext: {json.dumps(ext_used)},
  words: {words_js},
  bakeoffWords: {bakeoff_words_js},
  phonemes: {phonemes_js}
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
            "Generate TTS audio clips for Glyphs with Google Gemini Flash "
            "TTS, via OpenRouter (default) or the Gemini API direct. "
            "Reads the API key from the environment (see --api)."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Confirm the API contract (generates one 'cat' clip, prints diagnostics):
  python3 tools/tts/generate_clips.py --probe

  # Check the model is routable / list TTS models:
  python3 tools/tts/generate_clips.py --list-models

  # Full run (all voices, all clips):
  python3 tools/tts/generate_clips.py

  # Re-render everything for one voice only:
  python3 tools/tts/generate_clips.py --voices sulafat --force

  # Primary voice only, skip bake-off voices:
  python3 tools/tts/generate_clips.py --primary-only

  # The Gemini-direct fallback (needs GEMINI_API_KEY):
  python3 tools/tts/generate_clips.py --api gemini --probe
        """,
    )
    parser.add_argument(
        "--api", choices=sorted(API_CONFIGS.keys()), default=DEFAULT_API,
        help=(
            "TTS backend: 'openrouter' (plan of record, needs "
            "OPENROUTER_API_KEY) or 'gemini' (Google Gemini API direct "
            "fallback, needs GEMINI_API_KEY). Same voices either way. "
            f"Default: {DEFAULT_API!r}."
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
        help="Check/list the backend's TTS models and exit.",
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
            "(e.g. sulafat,aoede). Default: all configured voices."
        ),
    )
    parser.add_argument(
        "--words", default=None, metavar="FILE",
        help=(
            "Path to word list file (one 'word [category]' entry per "
            "line; '#' comments and blank lines ignored). "
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
    # Model listing (OpenRouter's endpoints are public; Gemini needs the key)
    # ------------------------------------------------------------------
    if args.list_models:
        api_key = resolve_api_key(api) if api == "gemini" else None
        list_models(api, api_key, model)
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

    raw_words, word_categories = parse_wordlist(words_file)
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
        print(f"[probe] api: {api}")
        print(f"[probe] model: {model}")
        print(f"[probe] out_dir: {out_dir}")
        run_probe(api, model, api_key, out_dir,
                  voice_dirname=PRIMARY_VOICE,
                  voice_api=VOICES[PRIMARY_VOICE])
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
        is_bakeoff = (voice_dirname != PRIMARY_VOICE) and (voice_dirname in BAKEOFF_VOICES)
        clips = clips_for_voice(raw_words, word_categories, voice_dirname, is_bakeoff)

        print(f"\n── Voice: {voice_dirname} ({'bake-off subset' if is_bakeoff else 'full set'}) "
              f"({len(clips)} clips) ──")

        counts = {"ok": 0, "skip": 0, "err": 0, "bytes": 0}
        voice_counts[voice_dirname] = counts

        for clip in clips:
            dest_base = clip_path(out_dir, voice_dirname,
                                  clip["category"], clip["stem"])

            # Special handling for the interjections (hmm, deflate): the
            # stem equals the category and there's no subdirectory — they
            # live directly under voicedir/<stem>.wav. The descriptor's
            # category="hmm" stem="hmm" would otherwise mean
            # out_dir/voice/hmm/hmm.wav — we want out_dir/voice/hmm.wav.
            # Re-map: if category == stem, output is voicedir/<stem>.*
            if clip["category"] in ("hmm", "deflate"):
                dest_base = out_dir / voice_dirname / clip["stem"]

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

            voice_api = VOICES[voice_dirname]
            try:
                audio_bytes, ext = call_tts_api(
                    api, clip["prompt"], voice_api, model, api_key
                )
            except RuntimeError as exc:
                print(f"  [ERROR] {dest_base}: {exc}", file=sys.stderr)
                counts["err"] += 1
                continue

            # Phoneme clips get additional post-processing for concatenation
            # quality: tight trim, fade-in/out, and RMS normalisation.
            if clip.get("post_process") == "phoneme" and ext == "wav":
                try:
                    audio_bytes = condition_phoneme(audio_bytes)
                except Exception as exc:  # noqa: BLE001
                    print(f"  [warn]  condition_phoneme failed for "
                          f"{clip['stem']}: {exc}", file=sys.stderr)

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
