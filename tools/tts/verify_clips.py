#!/usr/bin/env python3
"""
verify_clips.py — Glyphs Phase 3 clip-tree verifier (PHASE3-PLAN.md A4).

Checks the generated audio bundle under renderer/audio/ against
tools/tts/wordlist.txt and the pipeline's format contract:

  - the word list itself is well-formed (unique, lowercase a–z words);
  - every expected clip exists and is non-empty — primary voice: full
    word set + 26 phonemic letters + 26 letter names + hmm + deflate;
    bake-off voices: the frozen Phase 2 subsets + hmm + deflate;
  - every WAV is 24 kHz / mono / 16-bit;
  - durations fall within 0.2–6.0 s (catches the empty-audio and
    read-the-instructions-aloud failure modes);
  - tails are actually silent — peak sample over the final 80 ms
    (catches missing tail conditioning);
  - manifest.js matches the word list (order preserved) and the voice
    line-up; no orphan files under renderer/audio/.

Every failure prints on its own line, followed by a per-voice summary.
Exit status 0 only when fully clean; 1 otherwise.

Standard library only: no pip install required.
Runs unchanged on macOS and Linux.

Usage:
    python3 tools/tts/verify_clips.py            # full check
    python3 tools/tts/verify_clips.py --quick    # skip duration/tail scan
"""

import argparse
import array
import json
import pathlib
import re
import sys
import wave

# Same directory as generate_clips.py — share its constants and the
# wordlist parser instead of duplicating them.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from generate_clips import (  # noqa: E402
    BAKEOFF_LETTERS,
    BAKEOFF_VOICES,
    BAKEOFF_WORDS,
    CATEGORY_STYLES,
    LETTER_NAME_MAP,
    PHONEMIC_MAP,
    PRIMARY_VOICE,
    parse_wordlist,
)

# ---------------------------------------------------------------------------
# Format contract (see tools/tts/README.md — WAV / PCM format details)
# ---------------------------------------------------------------------------

EXPECTED_RATE     = 24000   # Hz
EXPECTED_CHANNELS = 1       # mono
EXPECTED_WIDTH    = 2       # bytes per sample (16-bit)

MIN_SECONDS = 0.2           # below: the empty-audio failure mode
MAX_SECONDS = 6.0           # above: the read-the-instructions failure mode

TAIL_MS       = 80          # window to scan (== the generator's TAIL_PAD_MS)
TAIL_PEAK_MAX = 327         # peak abs sample allowed in the tail (~1% FS)

WORD_RE = re.compile(r"^[a-z]+$")

# ---------------------------------------------------------------------------
# Expected file tree
# ---------------------------------------------------------------------------

def expected_files(words: list[str]) -> dict[str, list[str]]:
    """Return {voice: [relative clip paths]} for the full expected tree."""
    expected: dict[str, list[str]] = {}

    # Primary voice: full set.
    paths = [f"{PRIMARY_VOICE}/words/{w}.wav" for w in words]
    paths += [f"{PRIMARY_VOICE}/letters-phonemic/{l}.wav" for l in PHONEMIC_MAP]
    paths += [f"{PRIMARY_VOICE}/letters-name/{l}.wav" for l in LETTER_NAME_MAP]
    paths += [f"{PRIMARY_VOICE}/hmm.wav", f"{PRIMARY_VOICE}/deflate.wav"]
    expected[PRIMARY_VOICE] = paths

    # Bake-off voices: frozen Phase 2 subsets.
    for voice in BAKEOFF_VOICES:
        paths = [f"{voice}/words/{w}.wav" for w in BAKEOFF_WORDS]
        paths += [f"{voice}/letters-phonemic/{l}.wav" for l in BAKEOFF_LETTERS]
        paths += [f"{voice}/hmm.wav", f"{voice}/deflate.wav"]
        expected[voice] = paths

    return expected

# ---------------------------------------------------------------------------
# Per-file checks
# ---------------------------------------------------------------------------

def check_clip(path: pathlib.Path, quick: bool) -> list[str]:
    """Check one clip file; return a list of failure messages (empty = ok)."""
    if not path.exists():
        return ["missing"]
    if path.stat().st_size == 0:
        return ["empty file (0 bytes)"]
    if path.suffix != ".wav":
        return []  # only WAVs carry the format contract

    failures = []
    try:
        with wave.open(str(path), "rb") as wf:
            rate     = wf.getframerate()
            channels = wf.getnchannels()
            width    = wf.getsampwidth()
            n_frames = wf.getnframes()
            if rate != EXPECTED_RATE:
                failures.append(f"sample rate {rate} != {EXPECTED_RATE}")
            if channels != EXPECTED_CHANNELS:
                failures.append(f"channels {channels} != {EXPECTED_CHANNELS}")
            if width != EXPECTED_WIDTH:
                failures.append(f"sample width {width} != {EXPECTED_WIDTH} bytes")
            if quick or failures:
                return failures

            duration = n_frames / float(rate)
            if not (MIN_SECONDS <= duration <= MAX_SECONDS):
                failures.append(
                    f"duration {duration:.2f}s outside "
                    f"{MIN_SECONDS}–{MAX_SECONDS}s"
                )

            # Tail silence: peak abs sample over the final TAIL_MS.
            n_tail = min(n_frames, int(rate * TAIL_MS / 1000))
            wf.setpos(n_frames - n_tail)
            samples = array.array("h")
            samples.frombytes(wf.readframes(n_tail))
            peak = max((abs(s) for s in samples), default=0)
            if peak > TAIL_PEAK_MAX:
                failures.append(
                    f"tail not silent (peak {peak} > {TAIL_PEAK_MAX} "
                    f"over final {TAIL_MS}ms)"
                )
    except (wave.Error, EOFError) as exc:
        failures.append(f"unreadable WAV: {exc}")
    return failures

# ---------------------------------------------------------------------------
# Manifest check
# ---------------------------------------------------------------------------

def parse_manifest(manifest_path: pathlib.Path) -> dict:
    """Extract the manifest object from the generated manifest.js.

    The file is generated (stable shape): the object literal assigned to
    window.Glyphs.audio.manifest, with bare keys and JSON values. Quote
    the keys and hand it to json.loads.
    """
    text = manifest_path.read_text(encoding="utf-8")
    match = re.search(r"manifest\s*=\s*(\{.*?\});", text, re.DOTALL)
    if not match:
        raise ValueError("could not locate the manifest object literal")
    obj = re.sub(r"(\w+):", r'"\1":', match.group(1))
    return json.loads(obj)

def check_manifest(manifest_path: pathlib.Path, words: list[str]) -> list[str]:
    """Check manifest.js against the word list; return failure messages."""
    if not manifest_path.exists():
        return ["manifest.js: missing"]
    try:
        manifest = parse_manifest(manifest_path)
    except (ValueError, json.JSONDecodeError) as exc:
        return [f"manifest.js: unparseable ({exc})"]

    failures = []
    if manifest.get("primary") != PRIMARY_VOICE:
        failures.append(
            f"manifest.js: primary {manifest.get('primary')!r} != {PRIMARY_VOICE!r}"
        )
    if manifest.get("ext") != "wav":
        failures.append(f"manifest.js: ext {manifest.get('ext')!r} != 'wav'")
    voices = manifest.get("voices") or []
    for voice in [PRIMARY_VOICE] + BAKEOFF_VOICES:
        if voice not in voices:
            failures.append(f"manifest.js: voices missing {voice!r}")
    manifest_words = manifest.get("words") or []
    if manifest_words != words:
        missing = [w for w in words if w not in manifest_words]
        extra   = [w for w in manifest_words if w not in words]
        detail  = []
        if missing:
            detail.append(f"{len(missing)} wordlist words absent")
        if extra:
            detail.append(f"{len(extra)} extra: {extra[:10]}")
        if not detail:
            detail.append("order differs from wordlist")
        failures.append(f"manifest.js: words mismatch ({'; '.join(detail)})")
    return failures

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def parse_args(argv=None):
    """Parse command-line arguments."""
    parser = argparse.ArgumentParser(
        prog="verify_clips.py",
        description=(
            "Verify the generated Glyphs clip tree against the word list "
            "and the pipeline's format contract. Exit 0 only when clean."
        ),
    )
    parser.add_argument(
        "--quick", action="store_true",
        help="Skip the per-sample duration/tail-silence scan "
             "(existence + header checks only).",
    )
    parser.add_argument(
        "--words", default=None, metavar="FILE",
        help=(
            "Path to word list file (same format as the generator's). "
            "Default: tools/tts/wordlist.txt relative to repo root."
        ),
    )
    parser.add_argument(
        "--audio", default=None, metavar="DIR",
        help="Audio directory root (default: renderer/audio relative to "
             "repo root).",
    )
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    repo_root = pathlib.Path(__file__).resolve().parent.parent.parent
    words_file = (pathlib.Path(args.words).resolve() if args.words
                  else repo_root / "tools" / "tts" / "wordlist.txt")
    audio_dir = (pathlib.Path(args.audio).resolve() if args.audio
                 else repo_root / "renderer" / "audio")

    failures: list[str] = []

    # ------------------------------------------------------------------
    # Word list sanity
    # ------------------------------------------------------------------
    if not words_file.exists():
        print(f"ERROR: word list file not found: {words_file}", file=sys.stderr)
        return 1
    words, categories = parse_wordlist(words_file)
    seen: set[str] = set()
    for word in words:
        if not WORD_RE.match(word):
            failures.append(f"wordlist: {word!r} is not lowercase a–z")
        if word in seen:
            failures.append(f"wordlist: duplicate word {word!r}")
        seen.add(word)
    for word, category in categories.items():
        if category not in CATEGORY_STYLES:
            failures.append(
                f"wordlist: {word!r} has unknown category {category!r}"
            )

    # ------------------------------------------------------------------
    # Clip tree
    # ------------------------------------------------------------------
    expected = expected_files(words)
    print(f"Glyphs clip-tree verifier")
    print(f"  words:  {len(words)} words from {words_file}")
    print(f"  audio:  {audio_dir}")
    print(f"  mode:   {'quick (no duration/tail scan)' if args.quick else 'full'}")
    print()

    voice_summaries = []
    for voice, rel_paths in expected.items():
        ok = missing = bad = 0
        for rel in rel_paths:
            path = audio_dir / rel
            clip_failures = check_clip(path, args.quick)
            if not clip_failures:
                ok += 1
            elif clip_failures == ["missing"]:
                missing += 1
                failures.append(f"{rel}: missing")
            else:
                bad += 1
                for failure in clip_failures:
                    failures.append(f"{rel}: {failure}")
        voice_summaries.append(
            f"  {voice:15s}  expected={len(rel_paths):4d}  ok={ok:4d}  "
            f"missing={missing:4d}  bad={bad:4d}"
        )

    # ------------------------------------------------------------------
    # Manifest
    # ------------------------------------------------------------------
    failures.extend(check_manifest(audio_dir / "manifest.js", words))

    # ------------------------------------------------------------------
    # Orphans — nothing under audio_dir but manifest.js + the expected tree
    # ------------------------------------------------------------------
    allowed = {"manifest.js"}
    for rel_paths in expected.values():
        allowed.update(rel_paths)
    if audio_dir.is_dir():
        for path in sorted(audio_dir.rglob("*")):
            if path.is_file() and path.relative_to(audio_dir).as_posix() not in allowed:
                failures.append(f"orphan file: {path.relative_to(audio_dir)}")
    else:
        failures.append(f"audio directory missing: {audio_dir}")

    # ------------------------------------------------------------------
    # Report
    # ------------------------------------------------------------------
    for failure in failures:
        print(f"  [FAIL] {failure}")
    if failures:
        print()
    print("── Summary ──────────────────────────────")
    for line in voice_summaries:
        print(line)
    print(f"  {'TOTAL':15s}  failures={len(failures)}")
    print()
    if failures:
        print("RESULT: FAIL")
        return 1
    print("RESULT: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
