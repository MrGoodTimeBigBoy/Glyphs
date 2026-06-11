/* hub.js — Glyphs Phase 3 hub screen.
   Registers as the 'hub' state with window.Glyphs.state.

   Keyboard contract (keys arrive via state.js's router; ESC never does):
     printable keys   append to the buffer (letters lowercased); junk
                      characters are allowed in and resolve on submit
     Backspace        delete last character
     Enter            submit — ghost showing → the full ghosted keyword;
                      otherwise the buffer as typed
     ArrowUp/Down     alternatives list visible → move its highlight;
                      otherwise history recall / put-back
     everything else  absorbed (never leaks to the browser)

   Submit dispatch:
     exact keyword            → state.go(keyword), no history entry
     known word               → clip + history entry (+ flourish if decorated)
     unknown all-alpha        → hmm + sound-out, dim italic history entry
                                with per-letter highlight in sync
     junk (empty / non-alpha) → deflate clip + cursor wiggle, no history

   History: newest at the bottom, capped at 500, persisted via persist.js.
   Recall lifts an entry out of the stack onto the input line (the stack
   visually shifts to fill); typing any non-arrow key makes it editable.
*/

(function () {
  'use strict';

  var KEYWORDS    = ['hide', 'draw', 'find', 'say', 'speak', 'spell'];

  /* SPEAK phonemes — hardcoded, never sent through G2P.
     ARPABET: S P IY K                                    */
  var SPEAK_PHONEMES = ['S', 'P', 'IY', 'K'];
  var HISTORY_CAP = 500;
  /* Soft cap on the buffer so mashing can't push the line off-screen.
     Extra keys are absorbed silently — never punished, never leaked.  */
  var BUFFER_MAX  = 60;

  window.Glyphs.register('hub', {
    init: function () {

      /* ── DOM refs ──────────────────────────────────────────── */
      var hubEl       = document.getElementById('hub');
      var historyEl   = document.getElementById('hub-history');
      var inputLineEl = document.getElementById('hub-input-line');
      var textEl      = document.getElementById('hub-text');
      var cursorEl    = document.getElementById('hub-cursor');
      var ghostEl     = document.getElementById('hub-ghost');
      var altsEl      = document.getElementById('hub-alts');

      /* ── State ─────────────────────────────────────────────── */
      var buffer      = '';
      var history     = [];     /* [{ word, type, ts }] oldest first */
      var recallIndex = -1;     /* -1 = live line; 0 = most recent entry */
      var savedBuffer = '';     /* live buffer parked during a recall */
      var altIndex    = 0;      /* highlight in the alternatives list */

      /* Per-letter <span>s of the most recent sound-out entry, captured
         at submit so onLetter can light them in sync with the audio.  */
      var litSpans = null;

      /* ── Autocomplete ──────────────────────────────────────── */

      /* keywordMatches() — keywords the buffer is a PROPER prefix of,
         shortest first. Empty buffer and recalled entries never match
         (the ghost is a hint about what you're typing, not a billboard). */
      function keywordMatches() {
        if (!buffer || recallIndex !== -1) return [];
        var out = [];
        for (var i = 0; i < KEYWORDS.length; i++) {
          var k = KEYWORDS[i];
          if (k.length > buffer.length && k.indexOf(buffer) === 0) out.push(k);
        }
        out.sort(function (a, b) {
          if (a.length !== b.length) return a.length - b.length;
          return a < b ? -1 : 1;
        });
        return out;
      }

      /* ghostKeyword() — the keyword currently being ghosted, or null.
         With one match it's that match; with several, the highlighted
         alternative (defaults to the shortest).                       */
      function ghostKeyword() {
        var m = keywordMatches();
        if (!m.length) return null;
        var idx = altIndex < m.length ? altIndex : 0;
        return m[idx];
      }

      /* ── Rendering ─────────────────────────────────────────── */

      function recalledWord() {
        var entry = history[history.length - 1 - recallIndex];
        return entry ? entry.word : '';
      }

      function renderInput() {
        var live = recallIndex === -1;
        textEl.textContent = live ? buffer : recalledWord();
        inputLineEl.classList.toggle('hub-recalled', !live);

        var g = live ? ghostKeyword() : null;
        ghostEl.textContent = g ? g.slice(buffer.length) : '';

        /* Target-mode preview: if the buffer is exactly the OTHER mode's
           keyword (not the current mode), color the text in that mode's
           bright hue — a preview of where Enter leads. Remove both classes
           first, then apply the target one only when appropriate.        */
        textEl.classList.remove('hub-preview-speak', 'hub-preview-spell');
        if (live && buffer) {
          var mode = window.Glyphs.mode;
          var currentMode = mode ? mode.current() : 'speak';
          if (buffer === 'speak' && currentMode !== 'speak') {
            textEl.classList.add('hub-preview-speak');
          } else if (buffer === 'spell' && currentMode !== 'spell') {
            textEl.classList.add('hub-preview-spell');
          }
        }

        /* Alternatives list — only when more than one keyword matches. */
        var m = live ? keywordMatches() : [];
        altsEl.innerHTML = '';
        if (m.length > 1) {
          for (var i = 0; i < m.length; i++) {
            var row = document.createElement('div');
            row.className = 'hub-alt' + (i === altIndex ? ' sel' : '');
            row.textContent = m[i];
            altsEl.appendChild(row);
          }
        }
      }

      /* renderHistory() — rebuild the stack, newest at the bottom.
         The entry currently recalled onto the input line is omitted,
         which is exactly what makes the rest of the (bottom-anchored)
         stack shift one row to fill the gap.                          */
      function renderHistory() {
        historyEl.innerHTML = '';
        for (var i = 0; i < history.length; i++) {
          if (recallIndex !== -1 && i === history.length - 1 - recallIndex) continue;
          var entry = history[i];
          var row = document.createElement('div');
          row.className = 'hub-line hub-entry' +
            (entry.type === 'soundout' ? ' hub-soundout' : '');
          if (entry.type === 'soundout') {
            /* Per-letter spans so a fresh sound-out can light up. */
            for (var j = 0; j < entry.word.length; j++) {
              var s = document.createElement('span');
              s.textContent = entry.word.charAt(j);
              row.appendChild(s);
            }
          } else {
            row.textContent = entry.word;
          }
          historyEl.appendChild(row);
        }
      }

      /* ── Tiny animations ───────────────────────────────────── */

      /* nudge() — up-arrow past the top of history: the stack flinches
         but stays put. Re-triggerable via the reflow trick.           */
      function nudge() {
        historyEl.classList.remove('nudge');
        void historyEl.offsetWidth;
        historyEl.classList.add('nudge');
      }

      /* wiggle() — junk submit: the cursor shakes its head once. */
      function wiggle() {
        cursorEl.classList.remove('wiggle');
        void cursorEl.offsetWidth;
        cursorEl.classList.add('wiggle');
      }

      /* ── History bookkeeping ───────────────────────────────── */

      function pushHistory(entry) {
        history.push(entry);
        while (history.length > HISTORY_CAP) history.shift();
        renderHistory();
        var persist = window.Glyphs.persist;
        if (persist && persist.save) persist.save(history);
      }

      /* ── Submit ────────────────────────────────────────────── */

      function submit() {
        /* Enter on a recalled entry submits the recalled word. */
        var word = recallIndex !== -1 ? recalledWord() : buffer;

        /* Ghost showing → Enter submits the full ghosted keyword
           (discovery-friendly: the hint is also an offer).          */
        var g = ghostKeyword();
        if (g) word = g;

        buffer = '';
        recallIndex = -1;
        savedBuffer = '';
        altIndex = 0;
        litSpans = null;

        /* 1a. Mode keywords (speak / spell) — stay in the hub. No history. */
        if (word === 'speak' || word === 'spell') {
          var mode = window.Glyphs.mode;
          if (mode && mode.current() === word) {
            /* Already in that mode: absorbed quietly. */
            var tones = window.Glyphs.tones;
            if (tones && tones.tick) tones.tick();
          } else {
            /* Switch mode, then play the double-utterance. */
            if (mode) mode.set(word);
            var modeAudio = window.Glyphs.audio;
            if (modeAudio) {
              if (word === 'spell') {
                /* Spell the word SPELL by letter names. */
                modeAudio.spellWord('spell');
              } else {
                /* Pronounce SPEAK by phonemes: S P IY K.
                   Constant defined at the top of this module. */
                modeAudio.playPhonemes(SPEAK_PHONEMES);
              }
            }
          }
          renderInput();
          renderHistory();
          return;
        }

        /* 1b. World keywords → enter that world. No history entry. */
        for (var i = 0; i < KEYWORDS.length; i++) {
          if (KEYWORDS[i] === word) {
            renderInput();
            renderHistory();
            window.Glyphs.state.go(word);
            return;
          }
        }

        var audio = window.Glyphs.audio;
        var isJunk = !word || !/^[a-z]+$/.test(word);

        /* 4. Junk (empty / non-alpha) → deflate + wiggle, no history. */
        if (isJunk) {
          if (audio && audio.playDeflate) audio.playDeflate();
          wiggle();
          renderInput();
          renderHistory();
          return;
        }

        /* 2. Known word → speak it; decorated words also flourish. */
        if (audio && audio.isKnownWord && audio.isKnownWord(word)) {
          audio.play(word);
          pushHistory({ word: word, type: 'word', ts: Date.now() });
          var flourish = window.Glyphs.flourish;
          if (flourish && flourish.has(word)) flourish.play(word);
          renderInput();
          return;
        }

        /* 3. Unknown all-alpha → hmm + sound-out, dim italic entry.
           Push + render first so the entry's letter spans exist, then
           light them in sync via play()'s onLetter callback.          */
        pushHistory({ word: word, type: 'soundout', ts: Date.now() });
        renderInput();

        var lastRow = historyEl.lastElementChild;
        var spans = [];
        if (lastRow) {
          for (var j = 0; j < lastRow.children.length; j++) {
            spans.push(lastRow.children[j]);
          }
        }
        litSpans = spans;

        function clearLit() {
          for (var k = 0; k < spans.length; k++) {
            spans[k].classList.remove('lit');
          }
        }

        if (audio && audio.play) {
          audio.play(word, {
            /* idx counts sequence items; item 0 is "hmm", so the
               letter at sequence idx lives at spans[idx - 1].       */
            onLetter: function (letter, idx) {
              if (litSpans !== spans) return;   /* superseded */
              clearLit();
              var span = spans[idx - 1];
              if (span) span.classList.add('lit');
            },
            onDone: function () {
              if (litSpans !== spans) return;
              clearLit();
            },
          });
        }
      }

      /* ── Arrow keys ────────────────────────────────────────── */

      function onArrowUp() {
        /* Alternatives list visible → browse it instead of history. */
        var m = keywordMatches();
        if (m.length > 1) {
          if (altIndex > 0) altIndex -= 1;
          renderInput();
          return;
        }
        /* Past the top (or no history at all) → nudge, no wrap. */
        if (recallIndex >= history.length - 1) {
          nudge();
          return;
        }
        if (recallIndex === -1) savedBuffer = buffer;
        recallIndex += 1;
        renderHistory();
        renderInput();
      }

      function onArrowDown() {
        var m = keywordMatches();
        if (m.length > 1) {
          if (altIndex < m.length - 1) altIndex += 1;
          renderInput();
          return;
        }
        if (recallIndex === -1) return;   /* already on the live line */
        recallIndex -= 1;
        if (recallIndex === -1) {
          buffer = savedBuffer;
          savedBuffer = '';
        }
        renderHistory();
        renderInput();
      }

      /* ── Key handler (called by state.js's router) ─────────── */

      function onKey(e) {
        var key = e.key;

        if (key === 'ArrowUp')   { e.preventDefault(); onArrowUp();   return; }
        if (key === 'ArrowDown') { e.preventDefault(); onArrowDown(); return; }
        if (key === 'ArrowLeft' || key === 'ArrowRight') {
          e.preventDefault();   /* absorbed — no caret editing in v1 */
          return;
        }

        /* Enter first: on a recalled entry it submits the recalled word
           exactly as it reads — submit() handles that case itself (no
           ghost can apply: a recalled line never shows one).          */
        if (key === 'Enter') {
          e.preventDefault();
          submit();
          return;
        }

        /* Any other non-arrow key on a recalled entry → editable text. */
        if (recallIndex !== -1) {
          buffer = recalledWord();
          recallIndex = -1;
          savedBuffer = '';
          renderHistory();
        }

        if (key === 'Backspace') {
          e.preventDefault();
          if (buffer.length > 0) buffer = buffer.slice(0, -1);
          altIndex = 0;
          renderInput();
          return;
        }

        /* Printable keys append; letters are lowercased for display,
           anything else goes in as-is and resolves as junk on submit. */
        if (key.length === 1) {
          e.preventDefault();
          if (buffer.length < BUFFER_MAX) {
            var isLetter = /^[A-Za-z]$/.test(key);
            buffer += isLetter ? key.toLowerCase() : key;
            altIndex = 0;
            renderInput();
            /* Letter tones (DESIGN, Audio — Letter tones): each typed
               letter plays its fixed tone, quietly — typing should feel
               musical, never loud, and never compete with the clips.  */
            var tones = window.Glyphs.tones;
            if (isLetter && tones && tones.play) {
              tones.play(key.toLowerCase(), { gain: 0.35 });
            }
          }
          return;
        }

        /* Tab, Home, PageUp, bare Shift, … — absorb, never leak. */
        e.preventDefault();
      }

      /* ── Register as the 'hub' state ───────────────────────── */

      window.Glyphs.state.registerWorld('hub', {
        enter: function () {
          /* Hub view restored exactly: input cleared on exit, history
             intact — just bring the layer back.                      */
          hubEl.hidden = false;
        },
        exit: function () {
          buffer = '';
          recallIndex = -1;
          savedBuffer = '';
          altIndex = 0;
          renderInput();
          renderHistory();
          hubEl.hidden = true;
        },
        onKey: onKey,
      });

      /* ── Load persisted history (async; renders when ready) ── */

      var persist = window.Glyphs.persist;
      if (persist && persist.load) {
        persist.load(function (entries) {
          if (entries && entries.length) {
            /* Prepend: anything typed before the load resolved stays
               newest. Recall positions are reset to keep them sane.  */
            history = entries.concat(history);
            while (history.length > HISTORY_CAP) history.shift();
            recallIndex = -1;
            renderHistory();
            renderInput();
          }
        });
      }

      /* ── Initial render ────────────────────────────────────── */

      renderInput();
      renderHistory();
    },
  });

}());
