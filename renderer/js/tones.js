/* tones.js — Glyphs letter-tone synth (the cross-world musical layer).
   Registers as window.Glyphs.tones. Infrastructure, like audio.js: it
   loads before state.js and the worlds, so every world (and the hub)
   can assume it exists.

   DESIGN (Audio — Letter tones): every letter a–z has ONE fixed musical
   pitch, assigned once and used identically everywhere. The same tone
   for `c` plays when the hub sounds out `cat`, when the child presses
   `c` in `draw`, and when the machine spells a word in `say`. Words
   thereby become small melodies; the melodic pattern of a familiar word
   becomes another route to recognizing it.

   This is a small synth engine (a few Web Audio oscillators), NOT a
   pre-rendered asset, and NOT speech — no TTS of any kind here, ever.

   ── The letter → pitch mapping ────────────────────────────────────
   Pitches come from the C-major scale, ascending with the alphabet so
   the mapping itself is legible: `a` is the lowest note, `z` the
   highest. DESIGN says "a couple of octaves", but 26 *distinct* scale
   degrees need 25 diatonic steps — about 3.6 octaves — so the span here
   is C3..G6. The top few letters (w x y z, all rare) poke above the
   comfortable ~1050 Hz ceiling; their gain is tapered (see below) so
   nothing up there ever sounds shrill.

   The five vowels must land on chord tones of C major (root / 3rd /
   5th) so they ring against the consonants. With a plain alphabetic
   walk, a / e / o land there already; two single-neighbor swaps
   (i ↔ j, u ↔ v) put the other two in place. The vowels then outline
   the tonic triad across the whole range:

       a = C3 root · e = G3 fifth · i = E4 third · o = C5 root · u = C6 root

   Full table (degree positions after the i↔j and u↔v swaps):

     a  C3  130.81  ROOT      n  B4   493.88
     b  D3  146.83            o  C5   523.25  ROOT
     c  E3  164.81            p  D5   587.33
     d  F3  174.61            q  E5   659.26
     e  G3  196.00  FIFTH     r  F5   698.46
     f  A3  220.00            s  G5   783.99
     g  B3  246.94            t  A5   880.00
     h  C4  261.63            u  C6  1046.50  ROOT   (swapped with v)
     i  E4  329.63  THIRD     v  B5   987.77
     j  D4  293.66  (swapped  w  D6  1174.66
     k  F4  349.23   with i)  x  E6  1318.51
     l  G4  392.00            y  F6  1396.91
     m  A4  440.00            z  G6  1567.98

   ── Timbre ────────────────────────────────────────────────────────
   DESIGN flags "vowels get a fuller timbre" as an open call worth
   trying — tried here: vowels are a sine fundamental with a quiet
   octave partial and a slightly longer ring; consonants are a plain
   triangle with a shorter envelope. Both use a bell-like shape (fast
   attack, exponential decay). Gain is modest throughout so tones sit
   *under* the pre-rendered voice clips, never compete with them.

   ── API ───────────────────────────────────────────────────────────
     play(letter, opts)   play that letter's tone
                            opts.gain — gain scale (default 1)
                            opts.duration — duration scale (default 1)
     frequency(letter)    the letter's pitch in Hz (null for non-letters)
     buzz()               the soft wrong-key sound for `say` — gentle and
                          low, the closest Glyphs comes to negative
                          feedback, so it is kept kind: a quiet downward
                          sigh, not an error blat
     tick()               near-silent click for absorbed keys (mashing
                          answered, never punished)

   The AudioContext is created lazily on the first call — every call
   site is user-gesture-driven (a keypress or click), so autoplay
   policy is satisfied and nothing spins up at boot.
*/

(function () {
  'use strict';

  /* Letter → frequency (Hz). See the table in the header comment. */
  var FREQ = {
    a: 130.81, b: 146.83, c: 164.81, d: 174.61, e: 196.00,
    f: 220.00, g: 246.94, h: 261.63, i: 329.63, j: 293.66,
    k: 349.23, l: 392.00, m: 440.00, n: 493.88, o: 523.25,
    p: 587.33, q: 659.26, r: 698.46, s: 783.99, t: 880.00,
    u: 1046.50, v: 987.77, w: 1174.66, x: 1318.51, y: 1396.91,
    z: 1567.98,
  };

  var VOWELS = { a: true, e: true, i: true, o: true, u: true };

  /* ── Tuning ─────────────────────────────────────────────────────── */

  var CONSONANT_PEAK = 0.13;   /* triangle, shorter ring               */
  var CONSONANT_DUR  = 0.30;   /* seconds                              */
  var VOWEL_PEAK     = 0.16;   /* sine + quiet octave, longer ring     */
  var VOWEL_DUR      = 0.46;
  var VOWEL_OCTAVE   = 0.22;   /* octave partial, fraction of the peak */
  var ATTACK_S       = 0.008;  /* fast bell attack                     */

  /* Equal-loudness nudges: highs are tapered so the rare top letters
     never get shrill; the lowest notes get a touch of help against
     small-speaker rolloff.                                           */
  var TAPER_ABOVE_HZ = 1046.5; /* C6 — taper anything above this      */
  var BOOST_BELOW_HZ = 180;
  var BOOST_FACTOR   = 1.25;

  /* ── Lazy AudioContext ──────────────────────────────────────────── */

  var _ctx = null;
  var _master = null;          /* one shared GainNode under everything */

  function audioCtx() {
    if (!_ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;    /* no Web Audio — degrade to silence   */
      _ctx = new AC();
      _master = _ctx.createGain();
      _master.gain.value = 0.9;
      _master.connect(_ctx.destination);
    }
    if (_ctx.state === 'suspended') _ctx.resume();
    return _ctx;
  }

  /* bell(type, freq, peak, dur) — one bell-enveloped oscillator. */
  function bell(type, freq, peak, dur) {
    var c = audioCtx();
    if (!c) return;
    var t0 = c.currentTime;
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + ATTACK_S);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(_master);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  /* ── Public API ─────────────────────────────────────────────────── */

  function frequency(letter) {
    var l = (letter || '').toLowerCase();
    return FREQ.hasOwnProperty(l) ? FREQ[l] : null;
  }

  function play(letter, opts) {
    var f = frequency(letter);
    if (f === null) return;
    opts = opts || {};
    var gainScale = typeof opts.gain === 'number' ? opts.gain : 1;
    var durScale  = typeof opts.duration === 'number' ? opts.duration : 1;
    if (gainScale <= 0 || durScale <= 0) return;

    /* Equal-loudness shaping (see tuning constants above). */
    var loud = 1;
    if (f > TAPER_ABOVE_HZ) loud = TAPER_ABOVE_HZ / f;
    else if (f < BOOST_BELOW_HZ) loud = BOOST_FACTOR;

    var l = letter.toLowerCase();
    if (VOWELS[l]) {
      /* Fuller vowel: sine fundamental + a quiet octave partial. */
      var peak = VOWEL_PEAK * gainScale * loud;
      var dur  = VOWEL_DUR * durScale;
      bell('sine', f, peak, dur);
      bell('sine', f * 2, peak * VOWEL_OCTAVE, dur * 0.8);
    } else {
      bell('triangle', f, CONSONANT_PEAK * gainScale * loud,
           CONSONANT_DUR * durScale);
    }
  }

  /* buzz() — `say`'s wrong-key sound. A low, quiet downward sigh:
     a sine sliding from ~160 Hz to ~105 Hz over a quarter second.
     Deliberately soft — "not that one, try again", never "WRONG". */
  function buzz() {
    var c = audioCtx();
    if (!c) return;
    var t0 = c.currentTime;
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(160, t0);
    o.frequency.exponentialRampToValueAtTime(105, t0 + 0.22);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(0.10, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    o.connect(g);
    g.connect(_master);
    o.start(t0);
    o.stop(t0 + 0.31);
  }

  /* tick() — near-silent click for absorbed input (the machine
     noticed you, quietly). Same character as find.js's sfxClick.   */
  function tick() {
    bell('triangle', 1700, 0.022, 0.02);
  }

  /* ── Register ───────────────────────────────────────────────────── */

  window.Glyphs.register('tones', {
    init: function () {
      window.Glyphs.tones = {
        play: play,
        frequency: frequency,
        buzz: buzz,
        tick: tick,
      };
    },
  });

}());
