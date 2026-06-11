#!/usr/bin/env python3
"""
test_phonemes.py — Glyphs phoneme concatenation test harness.

Looks each word up in g2p/cmudict.dict, strips stress digits from the
ARPABET pronunciation, concatenates the corresponding phoneme WAV clips
from renderer/audio/callirrhoe/phonemes/ with per-class inter-phoneme
gaps, and writes the result to tmp/phoneme-test/<word>.wav.

If a real word clip exists (renderer/audio/callirrhoe/words/<word>.wav),
it is copied to tmp/phoneme-test/<word>_reference.wav so Ian can A/B
the two by ear.

Standard library only: no pip install required.

Usage:
    python3 tools/tts/test_phonemes.py
    python3 tools/tts/test_phonemes.py cat dog ship fish sun chop
    npm run test-phonemes

If phoneme clips have not been generated yet, the script explains exactly
what to run.
"""
from __future__ import annotations

import array
import io
import pathlib
import re
import shutil
import struct
import sys
import wave

# ---------------------------------------------------------------------------
# Inter-phoneme gap table — same classes and values as audio.js
# (ear-tuning candidates; change here AND in audio.js in lockstep)
# ---------------------------------------------------------------------------

# Stops
_GAP_STOPS      = 30   # ms
# Affricates
_GAP_AFFRICATES = 40   # ms
# Vowels
_GAP_VOWELS     = 60   # ms
# Fricatives, nasals, liquids, glides — everything else
_GAP_DEFAULT    = 50   # ms

_STOPS      = {"B", "D", "G", "K", "P", "T"}
_AFFRICATES = {"CH", "JH"}
_VOWELS     = {"AA", "AE", "AH", "AO", "AW", "AY",
               "EH", "ER", "EY", "IH", "IY",
               "OW", "OY", "UH", "UW"}

# Default sample rate matching the clip pipeline (24 kHz).
SAMPLE_RATE = 24000


def gap_ms(phoneme: str) -> int:
    """Return the inter-phoneme gap in ms for a given ARPABET symbol."""
    ph = phoneme.upper()
    if ph in _STOPS:
        return _GAP_STOPS
    if ph in _AFFRICATES:
        return _GAP_AFFRICATES
    if ph in _VOWELS:
        return _GAP_VOWELS
    return _GAP_DEFAULT


def silence_frames(ms: int, rate: int = SAMPLE_RATE) -> bytes:
    """Return a PCM byte string of zeros for the given duration in ms."""
    n_samples = int(rate * ms / 1000)
    return struct.pack(f"<{n_samples}h", *([0] * n_samples))


# ---------------------------------------------------------------------------
# CMUdict loader
# ---------------------------------------------------------------------------

def load_cmudict(dict_path: pathlib.Path) -> dict[str, list[str]]:
    """Load cmudict.dict into a word → phoneme-list mapping.

    Stress digits (0/1/2) are stripped from vowel symbols so the
    phoneme names match the filenames in renderer/audio/callirrhoe/phonemes/.

    Alternate pronunciations (cmudict uses word(2), word(3) suffixes)
    are skipped — only the first pronunciation is kept.
    """
    entries: dict[str, list[str]] = {}
    with dict_path.open(encoding="latin-1") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith(";"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            key = parts[0].lower()
            # Skip alternate pronunciations (word(2), word(3), …)
            if re.search(r"\(\d+\)$", key):
                continue
            phonemes = [re.sub(r"\d+$", "", p) for p in parts[1:]]
            entries[key] = phonemes
    return entries


# ---------------------------------------------------------------------------
# WAV helpers
# ---------------------------------------------------------------------------

def read_wav_pcm(path: pathlib.Path) -> tuple[array.array, int, int]:
    """Read a WAV file into s16le samples; return (samples, rate, channels)."""
    with wave.open(str(path), "rb") as wf:
        rate     = wf.getframerate()
        channels = wf.getnchannels()
        n_frames = wf.getnframes()
        raw      = wf.readframes(n_frames)
    samples = array.array("h")
    samples.frombytes(raw[: (len(raw) // 2) * 2])
    return samples, rate, channels


def write_wav_pcm(path: pathlib.Path, samples: array.array,
                  rate: int = SAMPLE_RATE, channels: int = 1) -> None:
    """Write an array of s16le samples to a WAV file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(channels)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(samples.tobytes())
    path.write_bytes(buf.getvalue())


def concatenate_phonemes(phoneme_list: list[str],
                         phonemes_dir: pathlib.Path) -> array.array:
    """Concatenate phoneme clips with per-class gaps into a single s16le array.

    Args:
        phoneme_list:  ARPABET symbols (stress digits already stripped).
        phonemes_dir:  Path to the directory containing <ph>.wav files.

    Returns:
        An array.array("h") of concatenated PCM samples.

    Raises:
        FileNotFoundError if a required phoneme clip is missing.
    """
    combined = array.array("h")
    for i, ph in enumerate(phoneme_list):
        clip_path = phonemes_dir / f"{ph.lower()}.wav"
        if not clip_path.exists():
            raise FileNotFoundError(
                f"Phoneme clip missing: {clip_path}\n"
                f"Generate it with:\n"
                f"  export OPENROUTER_API_KEY=sk-or-v1-...\n"
                f"  python3 tools/tts/generate_clips.py --primary-only"
            )
        samples, rate, channels = read_wav_pcm(clip_path)
        combined.extend(samples)
        # Add inter-phoneme gap after every phoneme except the last.
        if i < len(phoneme_list) - 1:
            gap = silence_frames(gap_ms(ph), rate=rate)
            gap_arr = array.array("h")
            gap_arr.frombytes(gap)
            combined.extend(gap_arr)
    return combined


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEFAULT_WORDS = ["cat", "dog", "ship", "fish", "sun", "chop"]


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    words = args if args else DEFAULT_WORDS

    repo_root = pathlib.Path(__file__).resolve().parent.parent.parent

    dict_path     = repo_root / "g2p" / "cmudict.dict"
    phonemes_dir  = repo_root / "renderer" / "audio" / "callirrhoe" / "phonemes"
    words_dir     = repo_root / "renderer" / "audio" / "callirrhoe" / "words"
    out_dir       = repo_root / "tmp" / "phoneme-test"

    # ------------------------------------------------------------------
    # Preflight checks
    # ------------------------------------------------------------------
    if not dict_path.exists():
        print(
            f"ERROR: CMU dict not found at {dict_path}\n"
            f"It should have been committed to the repo.  If missing, fetch it:\n"
            f"  curl -fsSL https://raw.githubusercontent.com/cmusphinx/cmudict/"
            f"master/cmudict.dict -o g2p/cmudict.dict",
            file=sys.stderr,
        )
        return 1

    if not phonemes_dir.is_dir():
        print(
            f"ERROR: Phoneme clip directory not found: {phonemes_dir}\n"
            f"Generate phoneme clips first:\n"
            f"  export OPENROUTER_API_KEY=sk-or-v1-...\n"
            f"  python3 tools/tts/generate_clips.py --primary-only",
            file=sys.stderr,
        )
        return 1

    # Check at least one phoneme clip exists before loading the whole dict.
    sample_ph = phonemes_dir / "aa.wav"
    if not sample_ph.exists():
        print(
            f"ERROR: No phoneme clips found in {phonemes_dir}\n"
            f"Generate them first:\n"
            f"  export OPENROUTER_API_KEY=sk-or-v1-...\n"
            f"  python3 tools/tts/generate_clips.py --primary-only",
            file=sys.stderr,
        )
        return 1

    # ------------------------------------------------------------------
    # Load dictionary
    # ------------------------------------------------------------------
    print(f"Loading CMU dict from {dict_path} …")
    cmudict = load_cmudict(dict_path)
    print(f"  {len(cmudict):,} entries loaded.")
    print()

    out_dir.mkdir(parents=True, exist_ok=True)
    errors = 0

    for word in words:
        word_lc = word.lower()
        if word_lc not in cmudict:
            print(f"  [skip]  {word!r} — not in CMU dict")
            errors += 1
            continue

        phoneme_list = cmudict[word_lc]
        print(f"  {word_lc:15s}  /{' '.join(phoneme_list)}/")

        # Concatenate phoneme clips.
        try:
            combined = concatenate_phonemes(phoneme_list, phonemes_dir)
        except FileNotFoundError as exc:
            print(f"  [ERROR] {word!r}: {exc}", file=sys.stderr)
            errors += 1
            continue

        # Write phoneme-concatenated output.
        out_path = out_dir / f"{word_lc}.wav"
        write_wav_pcm(out_path, combined)
        print(f"    -> {out_path.relative_to(repo_root)}")

        # Copy reference word clip if it exists.
        ref_src = words_dir / f"{word_lc}.wav"
        if ref_src.exists():
            ref_dst = out_dir / f"{word_lc}_reference.wav"
            shutil.copy2(ref_src, ref_dst)
            print(f"    -> {ref_dst.relative_to(repo_root)}  (reference)")

    print()
    if errors:
        print(f"Completed with {errors} error(s).  "
              f"Output directory: {out_dir}")
        return 1
    print(f"Done.  Output directory: {out_dir}")
    print("Open the WAV files side-by-side to A/B phoneme concatenation "
          "vs. the real word clip.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
