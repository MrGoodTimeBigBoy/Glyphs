/* say.js — Glyphs `say` world (Simon Says for spelling).
   Registers as the 'say' state with window.Glyphs.state.

   The machine spells a word at the child: the word sits across the
   screen as large dim letters with generous spacing, and during the
   SHOW phase each letter glows in sequence and plays its musical tone
   (window.Glyphs.tones — the cross-world letter-tone layer), then
   dims. Then the INPUT phase: the child types the word back letter by
   letter. Each correct letter glows again and replays its tone, a
   quiet echo confirming the sequence is rebuilding. A wrong key plays
   the soft buzz and resets the sequence to the FIRST letter of the
   word — the word stays, lit letters dim back gently, he just spells
   it again from the start. Not a loss; the machine is patient.

   Completion: the full word glows brightly, the machine pronounces it
   with the pre-rendered clip (the ONLY speech here — no TTS, ever),
   a beat, then a new word.

   Progression runs in WAVES: each wave climbs the word lengths from
   one letter (`a`, `i`) through two-letter sight words and three-letter
   CVC words up to the longest words in the curated pool, then resets
   to one-letter words with a faster show pace. ONLY the show pacing
   accelerates; input pacing never changes. No game over, no score,
   nothing on screen reflects the wave number, and everything resets
   when the world is re-entered (DESIGN: cross-world rule).

   Keyboard contract (keys arrive via state.js's router; ESC never does):
     SHOW phase, any key       → tiny visual ping only — the show is
                                 never interrupted or advanced
     INPUT, the next letter    → tile glows + tone echo; word done →
                                 bright glow + word clip + next word
     INPUT, any other letter   → soft buzz; lit tiles dim back gently;
                                 the sequence restarts at letter one
     COMPLETE, letter in word  → its tile pulses + a quiet tone (a
                                 little cheer, like find's celebrate)
     any non-letter key        → near-silent tick + baseline ping
                                 (mashing absorbed, never punished)

   Mouse: clicking a letter tile does NOT type it (that would
   trivialize the game) — the tile just glow-pulses, like a touch.
   Clicking anywhere else: tiny ping.

   Audio: tones/buzz/tick via window.Glyphs.tones; speech only via the
   pre-rendered word clip through window.Glyphs.audio.play on
   completion. Never window.speechSynthesis (the hard rule).
*/

(function () {
  'use strict';

  /* ── Word pools ───────────────────────────────────────────────────
     Curated by length from the hub's audio bundle and filtered against
     the manifest at init, so every word here is a word the hub can
     speak. Within each length the phonetically regular words come
     FIRST and the irregular sight words trail — early waves sample
     from the front of each pool and later waves open up the whole
     pool, so sight words layer in as the mechanic gets comfortable. */

  var POOLS = {
    1: ['a', 'i'],
    2: ['it', 'on', 'to', 'my', 'we', 'up', 'go', 'in', 'at', 'me',
        'no', 'am', 'an', 'is', 'he', 'be', 'do', 'so', 'us', 'by',
        'if', 'of', 'or', 'as'],
    3: [/* CVC first */
        'cat', 'dog', 'sun', 'mom', 'dad', 'run', 'bed', 'bug', 'big',
        'bat', 'box', 'cup', 'egg', 'fox', 'hat', 'hen', 'hop', 'hot',
        'hug', 'leg', 'pig', 'red', 'sit', 'six', 'ten', 'wet', 'mud',
        'nap', 'dig', 'bus', 'jam', 'nut',
        /* sight words layer in */
        'the', 'and', 'you', 'see', 'was', 'are', 'her', 'him', 'his',
        'out', 'now', 'new', 'yes', 'zoo', 'sky', 'one', 'two'],
    4: [/* regular first */
        'frog', 'fish', 'hand', 'milk', 'sock', 'duck', 'jump', 'swim',
        'wind', 'bath', 'lamp', 'sand', 'rock', 'pond', 'sled', 'crab',
        'stop', 'spin', 'clap', 'fast', 'soft', 'sing',
        /* sight words layer in */
        'moon', 'tree', 'star', 'rain', 'bird', 'blue', 'book', 'door',
        'bike', 'boat', 'play', 'cake', 'nose', 'baby', 'king', 'wave',
        'kiss', 'love', 'snow', 'good', 'help', 'home', 'said', 'they',
        'this', 'that', 'with', 'your'],
    5: [/* regular first */
        'black', 'green', 'truck', 'train', 'plant', 'stick', 'snack',
        'stand', 'grass', 'swing', 'sleep', 'smile', 'snake',
        /* friendlier-than-regular favorites layer in */
        'happy', 'bunny', 'puppy', 'candy', 'apple', 'cloud', 'mouse',
        'horse', 'sheep', 'three', 'tiger', 'whale', 'zebra'],
    6: [/* regular-ish first */
        'kitten', 'rabbit', 'carrot', 'turtle', 'dragon', 'rocket',
        'planet', 'spider', 'monkey', 'garden', 'flower', 'sister',
        /* the rest layer in */
        'banana', 'castle', 'cookie', 'purple', 'yellow', 'orange',
        'little', 'friend', 'pretty', 'school'],
  };

  var LENGTHS = [1, 2, 3, 4, 5, 6];

  /* Words drawn from each length tier per wave. A full wave is the
     climb 1→6 (13 words with the counts below) and then it rolls
     over to one-letter words at a faster show pace.                 */
  var PER_TIER = { 1: 1, 2: 2, 3: 3, 4: 3, 5: 2, 6: 2 };

  /* How much of each pool is open per wave (regular words live at the
     front, so early waves stay phonetically regular).               */
  function poolWindow(wave) {
    if (wave <= 1) return 0.6;
    if (wave === 2) return 0.8;
    return 1.0;
  }

  /* ── Pacing ───────────────────────────────────────────────────────
     ONLY the show step accelerates with the wave number; everything
     the child's own typing drives is wave-independent.              */

  var SHOW_STEP_BASE_MS  = 850;   /* per letter, wave 1               */
  var SHOW_STEP_MIN_MS   = 380;   /* the pace floor (wave 6+)         */
  var SHOW_STEP_FALLOFF  = 0.85;  /* per-wave multiplier              */
  var SHOW_LIT_FRACTION  = 0.62;  /* lit portion of each show step    */
  var SHOW_LEAD_MS       = 650;   /* dim word on screen before show   */
  var SHOW_TO_INPUT_MS   = 500;   /* breath between show and input    */
  var NEW_WORD_MS        = 450;   /* breath before a new word appears */
  var CELEBRATE_BEAT     = 1100;  /* pause after the word clip ends   */
  var CELEBRATE_CLIP_MS  = 350;   /* glow lands before the clip plays */

  function showStepMs(wave) {
    var ms = SHOW_STEP_BASE_MS * Math.pow(SHOW_STEP_FALLOFF, wave - 1);
    return Math.max(SHOW_STEP_MIN_MS, Math.round(ms));
  }

  /* Echo gains: the child's own letters are a quiet echo of the show. */
  var SHOW_GAIN  = 1.0;
  var INPUT_GAIN = 0.7;
  var CHEER_GAIN = 0.5;

  /* ── Module ─────────────────────────────────────────────────────── */

  window.Glyphs.register('say', {
    init: function () {

      /* ── DOM (built here — #say ships empty) ───────────────── */
      var sayEl  = document.getElementById('say');
      var wordEl = document.createElement('div');
      wordEl.className = 'say-word';
      var lineEl = document.createElement('div');
      lineEl.className = 'say-line';
      sayEl.appendChild(wordEl);
      sayEl.appendChild(lineEl);

      /* ── Pools, resolved against the manifest ──────────────── */
      var pools = {};
      (function filterPools() {
        var a = window.Glyphs.audio;
        var mw = (a && a.manifest && a.manifest.words) ? a.manifest.words : null;
        var known = null;
        if (mw) {
          known = {};
          for (var i = 0; i < mw.length; i++) known[mw[i]] = true;
        }
        for (var k = 0; k < LENGTHS.length; k++) {
          var len = LENGTHS[k];
          var kept = [];
          for (var j = 0; j < POOLS[len].length; j++) {
            if (!known || known[POOLS[len][j]]) kept.push(POOLS[len][j]);
          }
          if (kept.length) pools[len] = kept;
        }
      }());

      /* ── Round state ───────────────────────────────────────── */
      var active     = false;
      var phase      = 'idle';   /* 'idle' | 'show' | 'input' | 'complete' */
      var word       = '';
      var lastWord   = '';
      var tiles      = [];       /* one <span> per letter            */
      var inputIndex = 0;        /* next letter the child must type  */
      var wave       = 1;        /* show pace only; never displayed  */
      var queue      = [];       /* this wave's remaining words      */
      var _timers    = [];       /* pending setTimeouts              */
      var _token     = 0;        /* guards show/celebrate sequences  */

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

      function tones() { return window.Glyphs.tones || null; }

      /* ── Tiny visual responses ─────────────────────────────── */

      /* Baseline ping: the generic "the machine noticed you". */
      function linePing() {
        lineEl.classList.remove('ping');
        void lineEl.offsetWidth;
        lineEl.classList.add('ping');
      }

      /* Glow-pulse one tile without changing its lit state (the
         show-phase key ping and the clicked-tile "touch").        */
      function tilePing(el) {
        el.classList.remove('ping');
        void el.offsetWidth;
        el.classList.add('ping');
      }

      /* Lit transitions are fast in, slow out (styles.css), so adding
         is a pop and removing is the gentle dim the spec asks for.  */
      function light(el) { el.classList.add('lit'); }
      function dim(el)   { el.classList.remove('lit'); }

      function dimAll() {
        for (var i = 0; i < tiles.length; i++) dim(tiles[i]);
      }

      /* ── Waves ─────────────────────────────────────────────── */

      /* sample(pool, n, frac) — up to n distinct words from the open
         front `frac` of the pool, shuffled.                        */
      function sample(pool, n, frac) {
        var open = Math.max(1, Math.min(pool.length,
                   Math.ceil(pool.length * frac)));
        var src = pool.slice(0, open);
        for (var i = src.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = src[i]; src[i] = src[j]; src[j] = t;
        }
        return src.slice(0, Math.min(n, src.length));
      }

      /* buildQueue() — one wave's climb: lengths ascending, a few
         words per tier. The wave's first word never repeats the word
         the child just finished.                                   */
      function buildQueue() {
        queue = [];
        var frac = poolWindow(wave);
        for (var k = 0; k < LENGTHS.length; k++) {
          var len = LENGTHS[k];
          if (!pools[len]) continue;
          var picks = sample(pools[len], PER_TIER[len] || 1, frac);
          for (var i = 0; i < picks.length; i++) queue.push(picks[i]);
        }
        if (queue.length > 1 && queue[0] === lastWord) {
          queue.push(queue.shift());
        }
      }

      /* ── The show phase ────────────────────────────────────── */

      function buildTiles(w) {
        tiles = [];
        wordEl.innerHTML = '';
        wordEl.classList.remove('say-complete');
        for (var i = 0; i < w.length; i++) {
          var el = document.createElement('span');
          el.className = 'say-letter';
          el.textContent = w.charAt(i);
          wordEl.appendChild(el);
          tiles.push(el);
        }
      }

      /* runShow() — glow the letters in sequence, each with its tone,
         each dimming before the next. Chained later() calls under one
         token, so ESC mid-show cleans up with no timer resurrection. */
      function runShow() {
        phase = 'show';
        _token += 1;
        var tok  = _token;
        var step = showStepMs(wave);   /* the ONLY thing waves change */
        var i    = 0;

        function next() {
          if (tok !== _token) return;
          if (i >= tiles.length) {
            later(function () {
              if (tok !== _token) return;
              phase = 'input';
              inputIndex = 0;
              dimAll();   /* belt-and-braces; each tile already dimmed */
            }, SHOW_TO_INPUT_MS);
            return;
          }
          var tile = tiles[i];
          var ch   = word.charAt(i);
          light(tile);
          var t = tones();
          if (t) t.play(ch, { gain: SHOW_GAIN });
          later(function () {
            if (tok === _token) dim(tile);
          }, Math.round(step * SHOW_LIT_FRACTION));
          i += 1;
          later(next, step);
        }

        later(next, SHOW_LEAD_MS);
      }

      function newWord() {
        if (!queue.length) {
          /* The cycle topped out: next wave — back to one-letter
             words, show pace a notch quicker. Nothing announces it. */
          wave += 1;
          buildQueue();
        }
        word = queue.shift();
        lastWord = word;
        buildTiles(word);
        runShow();
      }

      /* ── Completion ────────────────────────────────────────── */

      function celebrate() {
        phase = 'complete';
        _token += 1;
        var tok = _token;
        wordEl.classList.add('say-complete');
        for (var i = 0; i < tiles.length; i++) {
          tiles[i].classList.add('bright');
        }

        var moved = false;
        function advance() {
          if (!active || tok !== _token || moved) return;
          moved = true;
          later(newWord, NEW_WORD_MS);
        }

        /* Read mode at the moment of completion — no cached copy. */
        var celebMode = (window.Glyphs.mode ? window.Glyphs.mode.current() : 'speak');

        if (celebMode === 'spell') {
          /* Spell mode: spell the word by letter names, no word clip after.
             The spelling IS the celebration — the bee structure commits here. */
          later(function () {
            if (tok !== _token) return;
            var audio = window.Glyphs.audio;
            if (audio && audio.spellWord) {
              audio.spellWord(word, {
                onDone: function () {
                  if (tok !== _token || !active) return;
                  later(advance, CELEBRATE_BEAT);
                },
              });
            }
          }, CELEBRATE_CLIP_MS);

          /* Safety net: longer timeout in spell mode — letter-name spelling
             of a longer word can take ~700ms per letter; without scaling the
             net would cut the spelling off mid-word.
             Base 4500ms + 800ms per letter guarantees the net fires after
             the longest plausible spellWord completes.                      */
          later(advance, 4500 + word.length * 800);
        } else {
          /* Speak mode (default): play the word clip, then advance. */
          later(function () {
            if (tok !== _token) return;
            var audio = window.Glyphs.audio;
            if (audio && audio.play) {
              audio.play(word, {
                onDone: function () {
                  if (tok !== _token || !active) return;
                  later(advance, CELEBRATE_BEAT);
                },
              });
            }
          }, CELEBRATE_CLIP_MS);

          /* Safety net: never stall if the clip is missing/never ends. */
          later(advance, 4500);
        }
      }

      /* ── Input ─────────────────────────────────────────────── */

      function onLetterKey(ch) {
        if (phase === 'show') {
          /* The show is sacred: at most a tiny visual ping. */
          linePing();
          return;
        }

        if (phase === 'complete') {
          /* The word is mid-glow: every key is a little cheer. */
          var hit = false;
          for (var i = 0; i < tiles.length; i++) {
            if (word.charAt(i) === ch) { tilePing(tiles[i]); hit = true; }
          }
          var t = tones();
          if (hit) { if (t) t.play(ch, { gain: CHEER_GAIN }); }
          else { if (t) t.tick(); linePing(); }
          return;
        }

        if (phase !== 'input') { linePing(); return; }

        if (ch === word.charAt(inputIndex)) {
          /* Right letter: glow + the quiet tone echo. */
          light(tiles[inputIndex]);
          var tn = tones();
          if (tn) tn.play(ch, { gain: INPUT_GAIN });
          inputIndex += 1;
          if (inputIndex >= word.length) celebrate();
          return;
        }

        /* Wrong key: the soft buzz, lit letters dim back gently, and
           the sequence restarts at the first letter. The word stays —
           he just spells it again. Not a loss.                      */
        var tb = tones();
        if (tb) tb.buzz();
        inputIndex = 0;
        dimAll();
      }

      function onKey(e) {
        e.preventDefault();
        var key = e.key;
        if (key.length === 1 && /^[A-Za-z]$/.test(key)) {
          onLetterKey(key.toLowerCase());
          return;
        }
        /* Space, enter, arrows, anything — absorbed, near-silently. */
        var t = tones();
        if (t) t.tick();
        linePing();
      }

      /* ── Mouse: a touch, never a keystroke ─────────────────── */

      function onPointerDown(e) {
        if (!active) return;
        var t = tones();
        var el = e.target;
        if (el && el.classList && el.classList.contains('say-letter')) {
          /* A clicked tile glows under the finger but does NOT type
             its letter — typing is the whole game.                 */
          tilePing(el);
          if (t) t.tick();
          return;
        }
        if (t) t.tick();
        linePing();
      }

      /* ── Register as the 'say' state ───────────────────────── */

      window.Glyphs.state.registerWorld('say', {
        enter: function () {
          active = true;
          wave = 1;            /* difficulty resets on every entry */
          lastWord = '';
          phase = 'idle';
          sayEl.hidden = false;
          buildQueue();
          later(newWord, NEW_WORD_MS);
        },
        exit: function () {
          active = false;
          _token += 1;
          clearTimers();
          phase = 'idle';
          word = '';
          tiles = [];
          inputIndex = 0;
          queue = [];
          wordEl.innerHTML = '';
          wordEl.classList.remove('say-complete');
          lineEl.classList.remove('ping');
          sayEl.hidden = true;
        },
        onKey: onKey,
      });

      sayEl.addEventListener('mousedown', onPointerDown);
    },
  });

}());
