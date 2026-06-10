/* hide.js — Glyphs Phase 5 `hide` world (the child's own invention).
   Registers as the 'hide' state with window.Glyphs.state.

   A wall of one letter fills the screen, breathing slowly. One impostor
   letter lives somewhere in it. Find it by pressing its key or clicking
   it (huge forgiving hitbox). The wall's breathing is the hint system:
   after a few seconds the impostor drifts out of phase with the rest of
   the wall, and the drift grows over time, so looking longer always
   helps. No explicit help is ever offered — time IS the hint.

   When found: the impostor grows bright, the rest of the wall scatters,
   the machine says the letter's name, and a new round begins.

   No score, no levels, no progress bars (DESIGN: cross-world rule).
   Difficulty drifts invisibly — the field/impostor pairs move from
   visually distinct (n/h, o/c) toward similar (n/m, o/e, b/d), and the
   drift hint starts later — and everything resets on re-entry.

   SPEED ROUND — every 4th–6th found, the calm wall becomes a churning
   field of w's where impostors (v, m, n) morph in and out quickly,
   sometimes several at once, sometimes duplicates. Catch them by key or
   click. It ends after a handful of catches or ~20 seconds, then the
   calm classic wall returns. Same shape vocabulary, different energy.

   HIDER MODE — discoverable by play, no menus, no instruction text:
   in the classic wall, typing the WALL's own letter over and over makes
   the wall stir more and more (it wakes), and on the fourth press the
   wall becomes the child's: an empty grid of dim dots with a blinking
   next-cell cursor. Each press of the wall letter lays a brick; typing
   any DIFFERENT letter plants the impostor (typing another one moves
   it). Enter — or just pausing once an impostor is planted — hands the
   wall to the machine, which theatrically seeks with an eye-like
   cursor: it glides between suspects, hovers, "hmm"s, and ALWAYS finds
   the impostor. Better-hidden impostors (bigger walls, similar letter
   shapes) take longer. Pacing is the feedback.

   Keyboard contract (keys arrive via state.js's router; ESC never does):
     classic — impostor key      → found
               wall letter       → the wall stirs (4 in a row → hider)
               anything else     → soft ping, round continues
     speed   — visible impostor  → caught (all matching at once)
               anything else     → soft ping
     hider   — wall letter       → lay a brick
               other letter      → plant/move the impostor
               Enter             → machine seeks (if an impostor exists)
               anything else     → soft ping
     seek / celebration          → every key is a tiny acknowledged cheer

   Mouse: clicking the impostor's cell (plus generous padding) finds or
   catches it; any other click pings the cell under the pointer.

   Audio: speech ONLY via pre-rendered clips through window.Glyphs.audio
   (playLetterName on a find, playHmm while the machine thinks). The
   small sound effects are synthesized here with the Web Audio API — no
   TTS of any kind, ever (the hard rule).

   Perf: one rAF loop writes per-cell transforms (translate/scale only)
   for a modest grid (~12–20 cols × 7–12 rows). All one-shot feedback is
   cheap CSS animation.
*/

(function () {
  'use strict';

  /* ── The pairing ladder ───────────────────────────────────────────
     Field/impostor pairs ordered by visual similarity. Early rounds
     draw from the distinct tier; later rounds drift toward the similar
     tier. Orientation is flipped at random (o/c is also c/o).        */

  var TIERS = [
    /* distinct — different silhouettes, easy to spot               */
    [['n', 'h'], ['o', 'c'], ['i', 't'], ['v', 'x'], ['s', 'z'], ['o', 'x']],
    /* medium — related but separable shapes                        */
    [['a', 'o'], ['p', 'q'], ['f', 't'], ['k', 'x'], ['w', 'v'], ['e', 's']],
    /* similar — near-twins; the drift hint earns its keep here     */
    [['n', 'm'], ['o', 'e'], ['c', 'e'], ['u', 'v'], ['b', 'd'],
     ['i', 'l'], ['h', 'n'], ['m', 'w']],
  ];

  /* ── Tuning ─────────────────────────────────────────────────────── */

  var HIDER_STREAK    = 4;       /* wall-letter presses to enter hider  */
  var HIDER_IDLE_MS   = 3500;    /* pause that hands the wall over      */
  var DRIFT_BASE_MS   = 5000;    /* impostor starts drifting at ~5s     */
  var DRIFT_PER_ROUND = 1200;    /* …later each round (invisible)       */
  var DRIFT_MAX_MS    = 12000;   /* …but never later than this          */
  var DRIFT_RAMP_MS   = 9000;    /* subtle → unmistakable over 9s       */
  var FOUND_BEAT_MS   = 2100;    /* celebration breath before next round */
  var SPEED_BASE      = 'w';     /* the speed round's churning field    */
  var SPEED_IMPS      = ['v', 'm', 'n'];
  var SPEED_GOAL      = 6;       /* catches that end a speed round      */
  var SPEED_MS        = 20000;   /* …or the clock does (keep it short)  */
  var SPEED_MAX_IMPS  = 3;       /* concurrent impostors                */
  var EYE_MOVE_MS     = 560;     /* matches the CSS left/top transition */
  var GHOST_CH        = '·';     /* hider mode's unbuilt-cell dot       */

  /* Shape of the grid: ~40–64px glyphs, edge to edge, cheap to wave. */
  function gridShape() {
    var w = window.innerWidth  || 1280;
    var h = window.innerHeight || 800;
    var cols = Math.max(12, Math.min(20, Math.round(w / 80)));
    var rows = Math.max(7,  Math.min(12, Math.round(h / 92)));
    return { cols: cols, rows: rows, cw: w / cols, ch: h / rows };
  }

  /* ── Synthesized sound effects (Web Audio, tiny and tasteful) ──── */

  var _actx = null;

  function audioCtx() {
    if (!_actx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) _actx = new AC();
    }
    if (_actx && _actx.state === 'suspended') _actx.resume();
    return _actx;
  }

  /* tone(type, f0, f1, peak, dur, delay) — one enveloped oscillator. */
  function tone(type, f0, f1, peak, dur, delay) {
    var c = audioCtx();
    if (!c) return;
    var t0 = c.currentTime + (delay || 0);
    var o = c.createOscillator();
    var g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    g.connect(c.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /* Near-silent click — any absorbed key (mashing absorbed, alive). */
  function sfxClick()  { tone('square', 1800, null, 0.025, 0.015); }
  /* The wall stirring — pitch climbs with each wall-letter press.   */
  function sfxWake(n)  { tone('triangle', 290 + n * 110, null, 0.10, 0.09); }
  /* A brick laid in hider mode — pitch wanders so walls sing a bit. */
  function sfxTick(i)  { tone('square', 760 + (i % 12) * 22, null, 0.05, 0.035); }
  /* The impostor planted — a low conspiratorial note.               */
  function sfxPlant()  { tone('sine', 233, 150, 0.12, 0.22); }
  /* The wall becomes yours — two small rising notes.                */
  function sfxInvite() { tone('sine', 392, null, 0.12, 0.12);
                         tone('sine', 523, null, 0.12, 0.16, 0.10); }
  /* Found! — a little major arpeggio.                               */
  function sfxFound()  { tone('sine', 523, null, 0.18, 0.16);
                         tone('sine', 784, null, 0.18, 0.18, 0.10);
                         tone('sine', 1046, null, 0.15, 0.30, 0.20); }
  /* A speed-round catch — quick and bright.                         */
  function sfxCatch()  { tone('triangle', 660, 990, 0.16, 0.12); }
  /* The speed round surging in / settling out.                      */
  function sfxSurge()  { tone('sawtooth', 110, 440, 0.06, 0.45); }
  function sfxSettle() { tone('sine', 520, 250, 0.08, 0.40); }

  /* ── Module ─────────────────────────────────────────────────────── */

  window.Glyphs.register('hide', {
    init: function () {

      /* ── DOM (built here; index.html only provides the shell) ── */
      var hideEl  = document.getElementById('hide');
      var fieldEl = document.createElement('div');
      fieldEl.className = 'hide-field';
      hideEl.appendChild(fieldEl);
      var eyeEl = document.createElement('div');
      eyeEl.className = 'hide-eye';
      eyeEl.hidden = true;
      hideEl.appendChild(eyeEl);

      /* ── State ─────────────────────────────────────────────── */
      var active = false;
      var mode   = 'classic';  /* classic | found | speed | settle |
                                  hider | seek                       */

      /* The grid. cells[i] = { ch, el, lit, phase }. lit=false marks
         hider mode's unbuilt ghost dots (they sit out of the wave). */
      var cells = [];
      var _cols = 1, _rows = 1, _cw = 1, _chh = 1;

      /* Classic round. */
      var fieldCh      = 'n';
      var impostorCh   = 'h';
      var impostorIdx  = 0;
      var roundStart   = 0;
      var rounds       = 0;     /* invisible difficulty; reset on enter */
      var lastPairKey  = '';
      var hiderStreak  = 0;     /* consecutive wall-letter presses      */
      var roundsToSpeed = 5;    /* classic founds until the speed round */

      /* Speed round. */
      var speedImps   = [];     /* [{ idx, ch, until }]                 */
      var catches     = 0;
      var speedEndAt  = 0;
      var nextSpawnAt = 0;

      /* Hider mode + seek. */
      var hiderBase   = 'n';
      var buildCursor = 0;      /* next cell the child's letters fill   */
      var impostorAt  = -1;     /* where the child hid it (-1: not yet) */
      var _idleSeq    = 0;      /* invalidates stale pause-handoff arms */
      var _nextEl     = null;   /* the blinking next-cell cursor        */

      /* Celebration. */
      var _foundIdx = -1;       /* the grown impostor (cheer target)    */

      /* Bookkeeping. */
      var _raf    = 0;
      var _timers = [];
      var _token  = 0;          /* bumped on every mode change + exit;
                                   guards every multi-step sequence     */

      function later(fn, ms) {
        var id = setTimeout(function () {
          var k = _timers.indexOf(id);
          if (k !== -1) _timers.splice(k, 1);
          if (active) fn();
        }, ms);
        _timers.push(id);
      }

      function clearTimers() {
        for (var i = 0; i < _timers.length; i++) clearTimeout(_timers[i]);
        _timers = [];
      }

      function audio() { return window.Glyphs.audio || null; }

      /* ── Grid geometry ─────────────────────────────────────── */

      function buildGrid(letter) {
        var g = gridShape();
        _cols = g.cols; _rows = g.rows; _cw = g.cw; _chh = g.ch;
        var fs = Math.max(34, Math.min(64, Math.floor(Math.min(_cw, _chh) * 0.66)));
        fieldEl.style.fontSize = fs + 'px';
        eyeEl.style.fontSize   = fs + 'px';
        fieldEl.style.gridTemplateColumns = 'repeat(' + _cols + ', 1fr)';
        fieldEl.style.gridTemplateRows    = 'repeat(' + _rows + ', 1fr)';
        fieldEl.innerHTML = '';
        cells = [];
        for (var r = 0; r < _rows; r++) {
          for (var c = 0; c < _cols; c++) {
            var el = document.createElement('span');
            el.className = 'hide-cell';
            el.textContent = letter;
            fieldEl.appendChild(el);
            cells.push({
              ch: letter,
              el: el,
              lit: true,
              /* Wave phase from grid position + a whisper of noise so
                 the breathing rolls diagonally without looking minted. */
              phase: c * 0.55 + r * 0.9 + Math.random() * 0.25,
            });
          }
        }
      }

      function cellCenter(idx) {
        var col = idx % _cols;
        var row = Math.floor(idx / _cols);
        return { x: (col + 0.5) * _cw, y: (row + 0.5) * _chh };
      }

      function cellIndexAt(x, y) {
        var col = Math.floor(x / _cw);
        var row = Math.floor(y / _chh);
        if (col < 0 || row < 0 || col >= _cols || row >= _rows) return -1;
        return row * _cols + col;
      }

      /* The glyph's cell plus generous padding (≈ a cell each side). */
      function hitNear(idx, x, y, slack) {
        var p = cellCenter(idx);
        return Math.abs(x - p.x) <= _cw  * (0.5 + slack) &&
               Math.abs(y - p.y) <= _chh * (0.5 + slack);
      }

      /* ── Tiny visual responses ─────────────────────────────── */

      function pulse(el) {
        el.classList.remove('ping');
        void el.offsetWidth;
        el.classList.add('ping');
      }

      /* n random lit cells flash — the wall noticing the child.   */
      function pulseRandom(n) {
        if (!cells.length) return;
        for (var k = 0; k < n; k++) {
          var c = cells[Math.floor(Math.random() * cells.length)];
          if (c.lit) pulse(c.el);
        }
      }

      function softClickAt(x, y) {
        sfxClick();
        var i = cellIndexAt(x, y);
        if (i >= 0 && cells[i]) pulse(cells[i].el);
      }

      function blinkEye() {
        eyeEl.classList.remove('blink');
        void eyeEl.offsetWidth;
        eyeEl.classList.add('blink');
      }

      /* ── The breathing wave (one rAF loop, transforms only) ─── */

      /* How far out of phase the impostor is, 0 → 1. Starts after a
         delay that lengthens as rounds progress (the invisible part)
         and ramps from imperceptible to unmistakable.              */
      function driftAmount(now) {
        var delay = Math.min(DRIFT_BASE_MS + rounds * DRIFT_PER_ROUND, DRIFT_MAX_MS);
        var d = (now - (roundStart + delay)) / DRIFT_RAMP_MS;
        return d <= 0 ? 0 : (d >= 1 ? 1 : d);
      }

      function waveTick(now) {
        if (mode === 'found') return;   /* scatter owns the transforms */
        var churning = (mode === 'speed');
        var amp = churning ? 6 : 2.6;
        var sp  = churning ? 0.005 : 0.0016;
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          if (!c.lit) continue;         /* ghost dots hold still       */
          var y = Math.sin(now * sp + c.phase) * amp;
          var x = churning ? Math.sin(now * 0.0036 + c.phase * 1.7) * 4 : 0;
          var tr = null;
          if (mode === 'classic' && i === impostorIdx) {
            var d = driftAmount(now);
            if (d > 0) {
              /* Out of phase, bigger swing, gently swelling.        */
              y = Math.sin(now * sp + c.phase + 2.6 * d) * amp * (1 + 2.4 * d);
              tr = 'translate(0px,' + y.toFixed(1) + 'px) scale(' +
                   (1 + 0.25 * d).toFixed(3) + ')';
            }
          }
          if (!tr) tr = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
          c.el.style.transform = tr;
        }
      }

      function step(now) {
        _raf = 0;
        if (!active) return;
        if (mode === 'speed') speedTick(now);
        waveTick(now);
        _raf = requestAnimationFrame(step);
      }

      /* ── The pairing ladder in motion ──────────────────────── */

      function pickPair() {
        var tier;
        var r = Math.random();
        if (rounds < 3)      tier = 0;                 /* warm-up        */
        else if (rounds < 6) tier = (r < 0.55) ? 1 : 0;
        else if (rounds < 9) tier = (r < 0.5)  ? 2 : 1;
        else                 tier = (r < 0.7)  ? 2 : 1; /* mostly twins  */
        var pool = TIERS[tier];
        var p = pool[Math.floor(Math.random() * pool.length)];
        for (var tries = 0; tries < 8 && (p[0] + p[1]) === lastPairKey; tries++) {
          p = pool[Math.floor(Math.random() * pool.length)];
        }
        lastPairKey = p[0] + p[1];
        return (Math.random() < 0.5) ? [p[1], p[0]] : [p[0], p[1]];
      }

      function isSimilar(a, b) {
        var t = TIERS[2];
        for (var i = 0; i < t.length; i++) {
          if ((t[i][0] === a && t[i][1] === b) ||
              (t[i][0] === b && t[i][1] === a)) return true;
        }
        return false;
      }

      /* ── Classic rounds ────────────────────────────────────── */

      function startClassicRound() {
        mode = 'classic';
        _token += 1;
        var pair = pickPair();
        fieldCh    = pair[0];
        impostorCh = pair[1];
        buildGrid(fieldCh);
        /* Anywhere but the very corners-of-reading positions.     */
        impostorIdx = 1 + Math.floor(Math.random() * (cells.length - 2));
        cells[impostorIdx].ch = impostorCh;
        cells[impostorIdx].el.textContent = impostorCh;
        roundStart  = performance.now();
        hiderStreak = 0;
        _foundIdx   = -1;
      }

      /* The shared celebration: the impostor grows bright, the rest
         of the wall scatters and fades, the machine says the letter,
         and after a breath `after()` starts whatever comes next.   */
      function celebrateFound(idx, after) {
        mode = 'found';
        _token += 1;
        var tok = _token;
        var star = cells[idx];
        _foundIdx = idx;
        sfxFound();

        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          if (i === idx) {
            c.el.style.transition = 'transform 450ms ease-out';
            c.el.style.transform  = 'translate(0px, 0px) scale(2.4)';
            c.el.classList.add('bright');
            continue;
          }
          var ang  = Math.random() * Math.PI * 2;
          var dist = 80 + Math.random() * 150;
          var dur  = Math.round(420 + Math.random() * 380);
          c.el.style.transition = 'transform ' + dur + 'ms ease-in, opacity ' +
                                  dur + 'ms ease-in';
          if (c.lit) {
            c.el.style.transform =
              'translate(' + Math.round(Math.cos(ang) * dist) + 'px,' +
                             Math.round(Math.sin(ang) * dist) + 'px) ' +
              'rotate(' + Math.round(-40 + Math.random() * 80) + 'deg)';
          }
          c.el.style.opacity = '0';   /* ghost dots just fade        */
        }

        /* Let the arpeggio lead, then the letter's name.           */
        later(function () {
          var a = audio();
          if (a && a.playLetterName) a.playLetterName(star.ch);
        }, 250);

        later(function () {
          if (tok !== _token) return;
          after();
        }, FOUND_BEAT_MS);
      }

      function foundClassic() {
        rounds += 1;               /* the invisible drift              */
        roundsToSpeed -= 1;
        var speedNext = roundsToSpeed <= 0;
        celebrateFound(impostorIdx, function () {
          if (speedNext) startSpeedRound();
          else startClassicRound();
        });
      }

      function classicKey(ch) {
        if (!ch) { sfxClick(); pulseRandom(1); return; }

        if (ch === impostorCh) { foundClassic(); return; }

        if (ch === fieldCh) {
          /* The wall's own letter: the wall stirs, more each press.
             Four in a row and the wall becomes the child's (hider). */
          hiderStreak += 1;
          if (hiderStreak >= HIDER_STREAK) { enterHider(); return; }
          sfxWake(hiderStreak);
          pulseRandom(hiderStreak * 3);
          return;
        }

        /* Any other letter: a soft ping, the round continues.      */
        hiderStreak = 0;
        sfxClick();
        pulseRandom(1);
      }

      /* ── Speed round ───────────────────────────────────────── */

      function startSpeedRound() {
        mode = 'speed';
        _token += 1;
        sfxSurge();
        buildGrid(SPEED_BASE);
        speedImps = [];
        catches   = 0;
        var now = performance.now();
        speedEndAt  = now + SPEED_MS;
        nextSpawnAt = now + 700;
      }

      function spawnImp(now) {
        var idx = -1;
        for (var t = 0; t < 20; t++) {
          var i = Math.floor(Math.random() * cells.length);
          var taken = false;
          for (var j = 0; j < speedImps.length; j++) {
            if (speedImps[j].idx === i) { taken = true; break; }
          }
          if (!taken) { idx = i; break; }
        }
        if (idx < 0) return;
        var ch = SPEED_IMPS[Math.floor(Math.random() * SPEED_IMPS.length)];
        var c = cells[idx];
        c.ch = ch;
        c.el.textContent = ch;
        c.el.classList.remove('swap');
        void c.el.offsetWidth;
        c.el.classList.add('swap');
        speedImps.push({ idx: idx, ch: ch, until: now + 1500 + Math.random() * 1100 });
      }

      function revertImp(imp) {
        var c = cells[imp.idx];
        c.ch = SPEED_BASE;
        c.el.textContent = SPEED_BASE;
        c.el.classList.remove('swap');
        void c.el.offsetWidth;
        c.el.classList.add('swap');
      }

      function catchImp(imp) {
        var i = speedImps.indexOf(imp);
        if (i !== -1) speedImps.splice(i, 1);
        catches += 1;
        sfxCatch();
        var c = cells[imp.idx];
        c.el.classList.remove('pop');
        void c.el.offsetWidth;
        c.el.classList.add('pop', 'bright');
        later(function () {
          c.ch = SPEED_BASE;
          c.el.textContent = SPEED_BASE;
          c.el.classList.remove('bright');
        }, 300);
      }

      function endSpeedRound() {
        for (var i = 0; i < speedImps.length; i++) revertImp(speedImps[i]);
        speedImps = [];
        mode = 'settle';
        _token += 1;
        sfxSettle();
        roundsToSpeed = 4 + Math.floor(Math.random() * 3);   /* 4–6 again */
        later(startClassicRound, 900);
      }

      /* Driven from the rAF loop while mode === 'speed'.          */
      function speedTick(now) {
        if (now >= speedEndAt || catches >= SPEED_GOAL) {
          endSpeedRound();
          return;
        }
        for (var i = speedImps.length - 1; i >= 0; i--) {
          if (now >= speedImps[i].until) {
            var gone = speedImps.splice(i, 1)[0];
            revertImp(gone);                 /* vanished — no penalty */
          }
        }
        if (now >= nextSpawnAt && speedImps.length < SPEED_MAX_IMPS) {
          spawnImp(now);
          nextSpawnAt = now + 420 + Math.random() * 640;
        }
      }

      function speedKey(ch) {
        if (!ch) { sfxClick(); pulseRandom(1); return; }
        var got = false;
        /* Duplicates welcome: the key catches every matching one.  */
        for (var i = speedImps.length - 1; i >= 0; i--) {
          if (speedImps[i].ch === ch) { catchImp(speedImps[i]); got = true; }
        }
        if (got) {
          var a = audio();
          if (a && a.playLetterName) a.playLetterName(ch);
        } else {
          sfxClick();
          pulseRandom(1);
        }
      }

      /* ── Hider mode (the child hides, the machine seeks) ───── */

      function markNext() {
        if (_nextEl) { _nextEl.classList.remove('next'); _nextEl = null; }
        if (buildCursor < cells.length) {
          _nextEl = cells[buildCursor].el;
          _nextEl.classList.add('next');
        }
      }

      function unmarkNext() {
        if (_nextEl) { _nextEl.classList.remove('next'); _nextEl = null; }
      }

      function fillCell(idx, ch) {
        var c = cells[idx];
        c.ch = ch;
        c.el.textContent = ch;
        c.lit = true;
        c.el.classList.remove('ghost', 'next');
        c.el.style.transform = '';
        pulse(c.el);
      }

      /* A pause hands the wall over — but only once an impostor is
         actually hidden in it. Re-armed on every hider keypress.   */
      function resetIdle() {
        _idleSeq += 1;
        var s = _idleSeq;
        later(function () {
          if (mode === 'hider' && s === _idleSeq && impostorAt >= 0) startSeek();
        }, HIDER_IDLE_MS);
      }

      function enterHider() {
        mode = 'hider';
        _token += 1;
        hiderBase   = fieldCh;
        impostorAt  = -1;
        buildCursor = 0;
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          c.ch = GHOST_CH;
          c.el.textContent = GHOST_CH;
          c.lit = false;
          c.el.classList.add('ghost');
          c.el.style.transform = '';
        }
        sfxInvite();
        /* The presses that woke the wall become its first bricks —
           the child's typing was already building it.              */
        for (var k = 0; k < HIDER_STREAK; k++) {
          fillCell(buildCursor, hiderBase);
          buildCursor += 1;
        }
        markNext();
        resetIdle();
      }

      function plantImpostor(idx, ch) {
        if (impostorAt >= 0) {
          /* Changed their mind: the old impostor melts back in.    */
          cells[impostorAt].ch = hiderBase;
          cells[impostorAt].el.textContent = hiderBase;
        }
        impostorAt = idx;
        sfxPlant();
      }

      function hiderKey(ch, key) {
        if (key === 'Enter') {
          if (impostorAt >= 0) { startSeek(); return; }
          /* Nothing hidden yet — the next-cell cursor clears its
             throat instead.                                        */
          sfxClick();
          if (buildCursor < cells.length) pulse(cells[buildCursor].el);
          return;
        }

        if (!ch) {
          sfxClick();
          if (buildCursor < cells.length) pulse(cells[buildCursor].el);
          resetIdle();
          return;
        }

        if (buildCursor >= cells.length) {
          /* The wall is full. Its own letter just pings; a different
             letter re-hides the impostor somewhere at random.       */
          if (ch === hiderBase) { sfxClick(); pulseRandom(1); resetIdle(); return; }
          var ridx = Math.floor(Math.random() * cells.length);
          plantImpostor(ridx, ch);
          fillCell(ridx, ch);
          resetIdle();
          return;
        }

        var idx = buildCursor;
        buildCursor += 1;
        if (ch === hiderBase) {
          fillCell(idx, ch);
          sfxTick(idx);
        } else {
          plantImpostor(idx, ch);
          fillCell(idx, ch);
        }
        markNext();
        resetIdle();

        /* A full wall with a hidden impostor: the machine leans in
           on its own after a short beat.                           */
        if (buildCursor >= cells.length && impostorAt >= 0) {
          later(function () {
            if (mode === 'hider' && impostorAt >= 0) startSeek();
          }, 800);
        }
      }

      /* ── The machine seeks (and ALWAYS succeeds) ───────────── */

      function moveEye(idx, instant) {
        var p = cellCenter(idx);
        if (instant) {
          eyeEl.style.transition = 'none';
          eyeEl.style.left = Math.round(p.x) + 'px';
          eyeEl.style.top  = Math.round(p.y) + 'px';
          void eyeEl.offsetWidth;
          eyeEl.style.transition = '';
        } else {
          eyeEl.style.left = Math.round(p.x) + 'px';
          eyeEl.style.top  = Math.round(p.y) + 'px';
        }
      }

      function startSeek() {
        mode = 'seek';
        _token += 1;
        var tok = _token;
        unmarkNext();

        /* Better-hidden impostors take longer: bigger walls and
           similar letter shapes earn more suspect hovers.          */
        var built = buildCursor > 0 ? buildCursor : cells.length;
        var hovers = 2 + Math.floor(built / 25) +
                     (isSimilar(hiderBase, cells[impostorAt].ch) ? 2 : 0);
        hovers = Math.max(2, Math.min(6, hovers));

        var path = [];
        var guard = 0;
        while (path.length < hovers && guard++ < 200) {
          var i = Math.floor(Math.random() * built);
          if (i === impostorAt || path.indexOf(i) !== -1) continue;
          path.push(i);
        }
        path.push(impostorAt);   /* the machine always succeeds      */

        var a = audio();
        if (a && a.playHmm) a.playHmm();

        eyeEl.hidden = false;
        moveEye(path[0], true);
        later(function () { seekStep(path, 0, tok); }, 450);
      }

      function seekStep(path, i, tok) {
        if (tok !== _token || mode !== 'seek') return;
        moveEye(path[i], false);
        var isLast = (i === path.length - 1);
        later(function () {
          if (tok !== _token || mode !== 'seek') return;
          blinkEye();
          /* A mid-search "hmm" — thinking out loud, not every stop. */
          if (!isLast && i === Math.floor(path.length / 2)) {
            var a = audio();
            if (a && a.playHmm) a.playHmm();
          }
          var hover = isLast ? 950 : 500 + Math.random() * 450;
          later(function () {
            if (tok !== _token || mode !== 'seek') return;
            if (isLast) seekFound();
            else seekStep(path, i + 1, tok);
          }, hover);
        }, EYE_MOVE_MS + 80);
      }

      function seekFound() {
        blinkEye();
        later(function () {
          if (mode !== 'seek') return;
          eyeEl.hidden = true;
          celebrateFound(impostorAt, function () {
            startClassicRound();
          });
        }, 320);
      }

      /* ── Input: keys ───────────────────────────────────────── */

      function onKey(e) {
        e.preventDefault();
        var key = e.key;
        var ch = (key.length === 1 && /^[A-Za-z]$/.test(key))
                   ? key.toLowerCase() : null;

        if (mode === 'classic') { classicKey(ch); return; }
        if (mode === 'speed')   { speedKey(ch);   return; }
        if (mode === 'hider')   { hiderKey(ch, key); return; }
        if (mode === 'seek')    { sfxClick(); blinkEye(); return; }

        /* found / settle — the moment glows; every key is a cheer. */
        sfxClick();
        if (mode === 'found' && _foundIdx >= 0 && cells[_foundIdx]) {
          pulse(cells[_foundIdx].el);
        }
      }

      /* ── Input: mouse (huge forgiving hitboxes) ────────────── */

      function onPointerDown(e) {
        if (!active) return;
        var x = e.clientX, y = e.clientY;

        if (mode === 'classic') {
          if (hitNear(impostorIdx, x, y, 0.85)) { foundClassic(); return; }
          softClickAt(x, y);
          return;
        }

        if (mode === 'speed') {
          var best = null, bestD = Infinity;
          for (var i = 0; i < speedImps.length; i++) {
            if (!hitNear(speedImps[i].idx, x, y, 0.9)) continue;
            var p = cellCenter(speedImps[i].idx);
            var d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
            if (d < bestD) { best = speedImps[i]; bestD = d; }
          }
          if (best) {
            var ch = best.ch;
            catchImp(best);
            var a = audio();
            if (a && a.playLetterName) a.playLetterName(ch);
            return;
          }
          softClickAt(x, y);
          return;
        }

        if (mode === 'seek') { sfxClick(); blinkEye(); return; }

        if (mode === 'found') {
          sfxClick();
          if (_foundIdx >= 0 && cells[_foundIdx]) pulse(cells[_foundIdx].el);
          return;
        }

        /* hider / settle: the cell under the pointer answers.      */
        softClickAt(x, y);
      }

      /* ── Register as the 'hide' state ──────────────────────── */

      window.Glyphs.state.registerWorld('hide', {
        enter: function () {
          active = true;
          rounds = 0;                                    /* difficulty   */
          roundsToSpeed = 4 + Math.floor(Math.random() * 3); /* resets   */
          lastPairKey = '';
          hideEl.hidden = false;
          startClassicRound();
          _raf = requestAnimationFrame(step);
        },
        exit: function () {
          active = false;
          _token += 1;
          _idleSeq += 1;
          if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
          clearTimers();
          unmarkNext();
          mode = 'classic';
          cells = [];
          speedImps = [];
          _foundIdx = -1;
          impostorAt = -1;
          fieldEl.innerHTML = '';
          eyeEl.hidden = true;
          hideEl.hidden = true;
        },
        onKey: onKey,
      });

      hideEl.addEventListener('mousedown', onPointerDown);
    },
  });

}());
