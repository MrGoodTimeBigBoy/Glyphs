/* find.js — Glyphs Phase 4 `find` world (the arcade beat).
   Registers as the 'find' state with window.Glyphs.state.

   Letters fall from the top of the screen. Near the bottom, fixed slots
   show the target word as faintly-ghosted letters. When a falling letter
   is near the catch line and the child presses its key (or clicks it),
   it locks into its slot with a small thunk and the letter's name clip.
   All slots filled → the word pulses, its flourish plays if it has one,
   and the word clip is spoken; a new word begins after a beat.

   No score, no levels, no progress bars (DESIGN: cross-world rule).
   Difficulty drifts invisibly with each completed word — word length
   creeps from two letters toward four, occasional distractor letters
   (not in the word) appear at the later stages, fall speed firms very
   slightly — and everything resets when the world is re-entered.

   Keyboard contract (keys arrive via state.js's router; ESC never does):
     needed letter, one catchable   → catch: it flies to its slot, locks
     needed letter, none catchable  → its ghost slot pulses + soft click
     letter already locked          → bonus chime (rewarded, not punished)
     distractor letter falling      → tiny dud; the letter fizzles away
     anything else                  → near-silent click + catch-line ping

   Mouse: clicking/tapping near a falling letter (huge forgiving hitbox)
   behaves like pressing its key.

   Audio: speech only via pre-rendered clips through window.Glyphs.audio
   (letter-name on a catch, word clip on completion). The small sound
   effects (thunk, chime, dud, click) are synthesized here with the Web
   Audio API — no TTS of any kind, ever (the hard rule).
*/

(function () {
  'use strict';

  /* ── Word pools ───────────────────────────────────────────────────
     Drawn from the hub vocabulary: sight words plus the 11 decorated
     words. Filtered against the audio manifest at init so only words
     with real clips are ever used.                                   */

  var POOLS = {
    2: ['go', 'in', 'it', 'me', 'my', 'no', 'up', 'we', 'at', 'an',
        'am', 'on', 'us', 'to', 'is', 'be', 'do', 'he', 'so'],
    3: ['cat', 'dog', 'sun', 'mom', 'dad', 'run', 'bed', 'bug', 'big',
        'box', 'bee', 'ant', 'bat', 'owl', 'cow', 'cup', 'egg', 'fox',
        'hat', 'hen', 'hop', 'hot', 'hug', 'leg', 'pig', 'red', 'car',
        'sit', 'six', 'ten', 'toy', 'wet', 'yes', 'zoo', 'mud', 'sky',
        'sea', 'eat', 'fly', 'one', 'two'],
    4: ['moon', 'tree', 'star', 'rain', 'fish', 'bird', 'frog', 'duck',
        'bear', 'lion', 'blue', 'pink', 'snow', 'wind', 'ball', 'book',
        'door', 'bike', 'boat', 'play', 'jump', 'swim', 'sing', 'cake',
        'milk', 'sock', 'shoe', 'nose', 'hand', 'baby', 'five', 'four',
        'nine', 'king', 'wave', 'kiss'],
  };

  /* The 11 decorated words get gentle priority so their flourishes
     keep showing up (worlds reinforce each other, per DESIGN).       */
  var DECORATED = ['cat', 'dog', 'sun', 'moon', 'tree', 'star',
                   'rain', 'fish', 'bird', 'mom', 'dad'];
  var DECORATED_BIAS = 0.35;   /* chance to pick from the decorated subset */

  /* ── Tuning ─────────────────────────────────────────────────────── */

  var MAX_FALLING    = 5;      /* concurrent falling letters             */
  var CATCH_TOP      = 0.42;   /* catchable from this fraction of height */
  var LINE_Y         = 0.74;   /* the visible catch line                 */
  var FADE_Y         = 0.84;   /* letters start fading past here         */
  var GONE_Y         = 0.95;   /* and are removed here (no penalty)      */
  var CLICK_RADIUS   = 110;    /* px — huge forgiving mouse hitbox       */
  var FLY_MS         = 170;    /* caught letter flies to its slot        */
  var CELEBRATE_BEAT = 1100;   /* pause after the word clip ends         */

  /* Difficulty drift — all derived from _completed (words finished
     since entering). Invisible: nothing on screen reflects any of it. */

  function lengthsFor(completed) {
    if (completed < 3)  return [2];          /* warm-up: two-letter     */
    if (completed < 5)  return [2, 3, 3];    /* mostly three            */
    if (completed < 8)  return [3];
    if (completed < 10) return [3, 4];
    return [4, 4, 3];                        /* mostly four, some three */
  }

  function distractorChance(completed) {
    if (completed < 5)  return 0;            /* none in the early drift */
    if (completed < 9)  return 0.12;
    if (completed < 13) return 0.20;
    return 0.28;
  }

  function fallSeconds(completed) {
    /* Gentle: full screen height in ~7s, firming to ~5.8s. */
    return 7.0 - Math.min(completed, 12) * 0.1;
  }

  function spawnIntervalMs(completed) {
    return 1500 - Math.min(completed, 12) * 40;
  }

  /* ── Synthesized sound effects (Web Audio, tiny and tasteful) ──── */

  var _ctx = null;

  function audioCtx() {
    if (!_ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) _ctx = new AC();
    }
    if (_ctx && _ctx.state === 'suspended') _ctx.resume();
    return _ctx;
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

  /* A low thunk with a bright little tick on top — the lock sound. */
  function sfxLock()  { tone('triangle', 196, 82, 0.5, 0.16);
                        tone('square', 1320, null, 0.08, 0.03); }
  /* Two quick sparkly notes — catching an already-locked letter.   */
  function sfxChime() { tone('sine', 659, null, 0.16, 0.18);
                        tone('sine', 988, null, 0.16, 0.22, 0.09); }
  /* A muffled little dud — pressing a distractor.                  */
  function sfxDud()   { tone('sine', 120, 75, 0.14, 0.10); }
  /* Near-silent click — any other key (mashing absorbed, alive).   */
  function sfxClick() { tone('square', 1800, null, 0.025, 0.015); }

  /* ── Module ─────────────────────────────────────────────────────── */

  window.Glyphs.register('find', {
    init: function () {

      /* ── DOM refs ──────────────────────────────────────────── */
      var findEl  = document.getElementById('find');
      var skyEl   = document.getElementById('find-sky');
      var lineEl  = document.getElementById('find-catchline');
      var slotsEl = document.getElementById('find-slots');

      /* ── Word pools, resolved against the manifest ─────────── */
      function manifestWords() {
        var a = window.Glyphs.audio;
        return (a && a.manifest && a.manifest.words) ? a.manifest.words : null;
      }

      var pools = { 2: POOLS[2], 3: POOLS[3], 4: POOLS[4] };
      (function filterPools() {
        var mw = manifestWords();
        if (!mw) return;   /* no manifest (shouldn't happen) — keep as-is */
        var known = {};
        for (var i = 0; i < mw.length; i++) known[mw[i]] = true;
        for (var len = 2; len <= 4; len++) {
          var kept = [];
          for (var j = 0; j < POOLS[len].length; j++) {
            if (known[POOLS[len][j]]) kept.push(POOLS[len][j]);
          }
          if (kept.length) pools[len] = kept;
        }
      }());

      /* ── Round state ───────────────────────────────────────── */
      var active     = false;
      var phase      = 'play';   /* 'play' | 'celebrate' */
      var word       = '';
      var lastWord   = '';
      var slots      = [];       /* [{ ch, filled, el }]            */
      var falling    = [];       /* [{ ch, x, y, speed, el }]       */
      var _completed = 0;        /* difficulty drift; reset on enter */
      var _raf       = 0;
      var _lastTs    = 0;
      var _nextSpawn = 0;        /* timestamp of the next spawn      */
      var _timers    = [];       /* pending setTimeouts (cleared on exit) */
      var _celebrateToken = 0;   /* guards the next-word handoff     */

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

      /* ── Tiny visual responses ─────────────────────────────── */

      /* Catch-line ping: the generic "the machine noticed you". */
      function linePing() {
        lineEl.classList.remove('ping');
        void lineEl.offsetWidth;
        lineEl.classList.add('ping');
      }

      /* Pulse the ghost slot for ch — a quiet hint, not a lesson. */
      function hintPulse(ch) {
        for (var i = 0; i < slots.length; i++) {
          if (!slots[i].filled && slots[i].ch === ch) {
            var el = slots[i].el;
            el.classList.remove('hint');
            void el.offsetWidth;
            el.classList.add('hint');
            return;
          }
        }
      }

      /* Sparkle every locked slot holding ch — the bonus-chime visual. */
      function sparkle(ch) {
        for (var i = 0; i < slots.length; i++) {
          if (slots[i].filled && slots[i].ch === ch) {
            var el = slots[i].el;
            el.classList.remove('pop');
            void el.offsetWidth;
            el.classList.add('pop');
          }
        }
      }

      /* ── Falling letters ───────────────────────────────────── */

      function removeFalling(f, fizzle) {
        var i = falling.indexOf(f);
        if (i !== -1) falling.splice(i, 1);
        if (fizzle) {
          f.el.classList.add('fizzle');
          var el = f.el;
          later(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
        } else if (f.el.parentNode) {
          f.el.parentNode.removeChild(f.el);
        }
      }

      function clearFalling(fizzle) {
        while (falling.length) removeFalling(falling[0], fizzle);
      }

      function unfilledChars() {
        var seen = {}, out = [];
        for (var i = 0; i < slots.length; i++) {
          var ch = slots[i].ch;
          if (!slots[i].filled && !seen[ch]) { seen[ch] = true; out.push(ch); }
        }
        return out;
      }

      function pickDistractor() {
        var abc = 'abcdefghijklmnopqrstuvwxyz';
        for (var tries = 0; tries < 20; tries++) {
          var ch = abc.charAt(Math.floor(Math.random() * 26));
          if (word.indexOf(ch) === -1) return ch;
        }
        return null;
      }

      function spawn() {
        if (falling.length >= MAX_FALLING) return;
        var need = unfilledChars();
        if (!need.length) return;

        var ch = null;
        if (Math.random() < distractorChance(_completed)) ch = pickDistractor();
        if (!ch) ch = need[Math.floor(Math.random() * need.length)];

        var h = window.innerHeight;
        var w = window.innerWidth;
        var el = document.createElement('div');
        el.className = 'find-letter';
        el.textContent = ch;
        skyEl.appendChild(el);

        var f = {
          ch: ch,
          x: w * (0.10 + 0.80 * Math.random()),
          y: -h * 0.06,
          speed: h / (fallSeconds(_completed) * 1000),   /* px per ms */
          el: el,
        };
        el.style.left = Math.round(f.x) + 'px';
        el.style.top  = Math.round(f.y) + 'px';
        falling.push(f);
      }

      /* ── The animation loop ────────────────────────────────── */

      function step(now) {
        _raf = 0;
        if (!active) return;
        var dt = _lastTs ? Math.min(now - _lastTs, 100) : 16;
        _lastTs = now;

        var h = window.innerHeight;
        for (var i = falling.length - 1; i >= 0; i--) {
          var f = falling[i];
          f.y += f.speed * dt;
          if (f.y > h * GONE_Y) {
            /* Missed — no penalty; the same letter will come again. */
            removeFalling(f, false);
            continue;
          }
          f.el.style.top = Math.round(f.y) + 'px';
          if (f.y > h * FADE_Y) {
            var t = (f.y - h * FADE_Y) / (h * (GONE_Y - FADE_Y));
            f.el.style.opacity = String(Math.max(0, 1 - t));
          }
        }

        if (phase === 'play' && now >= _nextSpawn) {
          spawn();
          var iv = spawnIntervalMs(_completed);
          _nextSpawn = now + iv * (0.8 + 0.4 * Math.random());
        }

        _raf = requestAnimationFrame(step);
      }

      /* ── Rounds ────────────────────────────────────────────── */

      function pickWord() {
        var lens = lengthsFor(_completed);
        var len  = lens[Math.floor(Math.random() * lens.length)];
        var pool = pools[len] || pools[2];

        /* Gentle decorated bias, when the pool has any. */
        var src = pool;
        if (Math.random() < DECORATED_BIAS) {
          var dec = [];
          for (var i = 0; i < pool.length; i++) {
            if (DECORATED.indexOf(pool[i]) !== -1) dec.push(pool[i]);
          }
          if (dec.length) src = dec;
        }

        var w = src[Math.floor(Math.random() * src.length)];
        if (w === lastWord && src.length > 1) {
          w = src[Math.floor(Math.random() * src.length)];
          if (w === lastWord) {
            w = src[(src.indexOf(w) + 1) % src.length];
          }
        }
        return w;
      }

      function newWord() {
        word = pickWord();
        lastWord = word;
        phase = 'play';

        slots = [];
        slotsEl.innerHTML = '';
        slotsEl.classList.remove('find-complete');
        for (var i = 0; i < word.length; i++) {
          var el = document.createElement('span');
          el.className = 'find-slot';
          el.textContent = word.charAt(i);
          slotsEl.appendChild(el);
          slots.push({ ch: word.charAt(i), filled: false, el: el });
        }

        clearFalling(false);
        _nextSpawn = performance.now() + 400;   /* first letter soon */
      }

      function celebrate() {
        phase = 'celebrate';
        _completed += 1;                        /* the invisible drift */
        clearFalling(true);
        slotsEl.classList.add('find-complete');

        var flourish = window.Glyphs.flourish;
        if (flourish && flourish.has(word)) flourish.play(word);

        /* Speak the word, then a beat, then the next word. The token
           guards against a stale onDone after exit/re-enter.         */
        _celebrateToken += 1;
        var myToken = _celebrateToken;
        var moved = false;
        function advance() {
          if (!active || myToken !== _celebrateToken || moved) return;
          moved = true;
          newWord();
        }

        var audio = window.Glyphs.audio;
        if (audio && audio.play) {
          audio.play(word, {
            onDone: function () { later(advance, CELEBRATE_BEAT); },
          });
        }
        /* Safety net: never stall if the clip is missing or never ends. */
        later(advance, 4500);
      }

      /* ── Catching ──────────────────────────────────────────── */

      function firstUnfilledSlot(ch) {
        for (var i = 0; i < slots.length; i++) {
          if (!slots[i].filled && slots[i].ch === ch) return slots[i];
        }
        return null;
      }

      function isNeeded(ch)  { return firstUnfilledSlot(ch) !== null; }
      function isLocked(ch)  {
        if (word.indexOf(ch) === -1) return false;
        return !isNeeded(ch);
      }

      function catchable(f) {
        return f.y >= window.innerHeight * CATCH_TOP;
      }

      /* Lowest catchable falling instance of ch (closest to the line). */
      function findCatchable(ch) {
        var best = null;
        for (var i = 0; i < falling.length; i++) {
          var f = falling[i];
          if (f.ch !== ch || !catchable(f)) continue;
          if (!best || f.y > best.y) best = f;
        }
        return best;
      }

      function lockSlot(slot) {
        slot.filled = true;
        slot.el.classList.add('locked');
        slot.el.classList.remove('pop');
        void slot.el.offsetWidth;
        slot.el.classList.add('pop');
      }

      function doCatch(f) {
        var slot = firstUnfilledSlot(f.ch);
        if (!slot) return;   /* shouldn't happen; guarded by callers */

        sfxLock();

        /* The letter flies to its slot, then the slot locks bright. */
        var i = falling.indexOf(f);
        if (i !== -1) falling.splice(i, 1);
        var el = f.el;
        var r = slot.el.getBoundingClientRect();
        el.classList.add('caught');
        el.style.transition = 'left ' + FLY_MS + 'ms ease-in, top ' + FLY_MS + 'ms ease-in, opacity ' + FLY_MS + 'ms linear';
        el.style.left = Math.round(r.left + r.width / 2) + 'px';
        el.style.top  = Math.round(r.top + r.height / 2) + 'px';
        el.style.opacity = '0.25';

        later(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
          lockSlot(slot);

          /* Word done? Straight to the word clip — skip the letter
             name so the completion moment belongs to the word.      */
          var done = true;
          for (var k = 0; k < slots.length; k++) {
            if (!slots[k].filled) { done = false; break; }
          }
          if (done) {
            celebrate();
            return;
          }

          var audio = window.Glyphs.audio;
          if (audio && audio.playLetterName) audio.playLetterName(slot.ch);
        }, FLY_MS);
      }

      /* ── Input: keys ───────────────────────────────────────── */

      function onLetterKey(ch) {
        if (phase === 'celebrate') {
          /* The word is mid-glow: every key is a little cheer. */
          if (word.indexOf(ch) !== -1) { sfxChime(); sparkle(ch); }
          else { sfxClick(); linePing(); }
          return;
        }

        if (isNeeded(ch)) {
          var f = findCatchable(ch);
          if (f) { doCatch(f); return; }
          /* Right letter, nothing near the line: pulse its ghost. */
          sfxClick();
          hintPulse(ch);
          return;
        }

        if (isLocked(ch)) {
          /* Already caught — bonus chime, rewarded not punished. */
          sfxChime();
          sparkle(ch);
          return;
        }

        /* A distractor that's actually falling fizzles with a dud. */
        for (var i = 0; i < falling.length; i++) {
          if (falling[i].ch === ch) {
            sfxDud();
            removeFalling(falling[i], true);
            return;
          }
        }

        /* Any other letter: the machine noticed you, quietly. */
        sfxClick();
        linePing();
      }

      function onKey(e) {
        e.preventDefault();
        var key = e.key;
        if (key.length === 1 && /^[A-Za-z]$/.test(key)) {
          onLetterKey(key.toLowerCase());
          return;
        }
        /* Space, enter, arrows, anything — absorbed with a tiny ping. */
        sfxClick();
        linePing();
      }

      /* ── Input: mouse (huge forgiving hitboxes) ────────────── */

      function onPointerDown(e) {
        if (!active) return;

        /* Nearest falling letter within the generous radius. */
        var best = null, bestD = CLICK_RADIUS;
        for (var i = 0; i < falling.length; i++) {
          var f = falling[i];
          var dx = f.x - e.clientX;
          var dy = f.y - e.clientY;
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d < bestD) { best = f; bestD = d; }
        }

        if (!best) { sfxClick(); linePing(); return; }

        if (phase === 'celebrate') { sfxChime(); return; }

        if (isNeeded(best.ch) && catchable(best)) { doCatch(best); return; }
        if (isLocked(best.ch)) { sfxChime(); sparkle(best.ch); return; }
        if (word.indexOf(best.ch) === -1) {
          sfxDud();
          removeFalling(best, true);
          return;
        }
        /* Needed but still too high: a wobble — soon, little one. */
        sfxClick();
        best.el.classList.remove('wobble');
        void best.el.offsetWidth;
        best.el.classList.add('wobble');
      }

      /* ── Register as the 'find' state ──────────────────────── */

      window.Glyphs.state.registerWorld('find', {
        enter: function () {
          active = true;
          _completed = 0;        /* difficulty resets on every entry */
          lastWord = '';
          _lastTs = 0;
          findEl.hidden = false;
          newWord();
          _raf = requestAnimationFrame(step);
        },
        exit: function () {
          active = false;
          _celebrateToken += 1;
          if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
          clearTimers();
          phase = 'play';
          falling = [];
          skyEl.innerHTML = '';
          slotsEl.innerHTML = '';
          slotsEl.classList.remove('find-complete');
          findEl.hidden = true;
        },
        onKey: onKey,
      });

      findEl.addEventListener('mousedown', onPointerDown);
    },
  });

}());
