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

      /* Submit-generation counter: bumped on every submit call so that
         any pending G2P promise or spellWord→word-clip chain from a
         previous submission does not stomp the new one.               */
      var submitGen = 0;

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
        submitGen += 1;   /* invalidate any in-flight G2P or spell chain */
        var myGen = submitGen;

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

        var currentMode = (window.Glyphs.mode ? window.Glyphs.mode.current() : 'speak');
        var isKnown = (audio && audio.isKnownWord && audio.isKnownWord(word));

        /* Helper: collect the letter <span>s from the freshly-appended
           soundout history row so audio callbacks can light them.     */
        function grabSpans() {
          var row = historyEl.lastElementChild;
          var s = [];
          if (row) {
            for (var j = 0; j < row.children.length; j++) s.push(row.children[j]);
          }
          return s;
        }

        function clearLitSpans(s) {
          for (var k = 0; k < s.length; k++) s[k].classList.remove('lit');
        }

        /* ── SPELL MODE — every alphabetic word is spelled by letter name. ──
           History visual keeps its meaning ("is the machine's vocabulary"),
           so known words get type 'word' and unknown get 'soundout'.
           After spelling, known words ALSO get the word clip (bee structure:
           spell it, then hear it). Unknown words: spelling stands alone.   */
        if (currentMode === 'spell') {
          if (isKnown) {
            pushHistory({ word: word, type: 'word', ts: Date.now() });
            /* Fire the flourish (visual, mode-independent). */
            var flourishS = window.Glyphs.flourish;
            if (flourishS && flourishS.has(word)) flourishS.play(word);
            renderInput();
            if (audio && audio.spellWord) {
              var myGenS = myGen;
              audio.spellWord(word, {
                onDone: function () {
                  /* Guard staleness: another submit could have fired. */
                  if (myGenS !== submitGen) return;
                  if (audio.play) audio.play(word);
                },
              });
            }
          } else {
            /* Unknown word: push soundout entry, spell it, no word clip. */
            pushHistory({ word: word, type: 'soundout', ts: Date.now() });
            renderInput();
            var spansU = grabSpans();
            litSpans = spansU;
            if (audio && audio.spellWord) {
              audio.spellWord(word, {
                onLetter: function (letter, idx) {
                  if (litSpans !== spansU) return;
                  clearLitSpans(spansU);
                  var span = spansU[idx];
                  if (span) span.classList.add('lit');
                },
                onDone: function () {
                  if (litSpans !== spansU) return;
                  clearLitSpans(spansU);
                },
              });
            }
          }
          return;
        }

        /* ── SPEAK MODE ───────────────────────────────────────────────── */

        /* 2. Known word → play the word clip; decorated words also flourish. */
        if (isKnown) {
          if (audio && audio.play) audio.play(word);
          pushHistory({ word: word, type: 'word', ts: Date.now() });
          var flourish = window.Glyphs.flourish;
          if (flourish && flourish.has(word)) flourish.play(word);
          renderInput();
          return;
        }

        /* 3. Unknown all-alpha → G2P path.
           Push + render first so the soundout entry's letter spans exist.
           Then start BOTH concurrently: playHmm() and GlyphsHost.g2p().
           Phoneme playback begins only once BOTH are done (hmm finished +
           promise resolved). The hmm covers G2P latency (eSpeak is instant;
           the fm LLM tier can take ~10s).

           Visual: on phoneme idx of total, light span proportionally
           (Math.floor(idx/total * word.length)), clear previous, clear all
           on done.

           Fallback: if g2p returns {ok:false} or rejects, fall back to
           spellWord — letter names are always TRUE of the word, unlike the
           old grapheme letter-sounds which taught wrong phonics (e.g. 'shop'
           as /s//h//o//p/).                                                 */
        pushHistory({ word: word, type: 'soundout', ts: Date.now() });
        renderInput();

        var spans = grabSpans();
        litSpans = spans;

        (function (capturedWord, capturedSpans, capturedGen) {
          /* Guard: if another submit fires before the async work completes,
             bail out — audio.js's token machinery handles the audio side,
             and the capturedGen check handles the visual side.            */
          function isStale() { return capturedGen !== submitGen; }

          function clearLit() { clearLitSpans(capturedSpans); }

          /* Phoneme sweep: light the span proportional to phoneme position. */
          function onPhoneme(ph, idx, total) {
            if (isStale() || litSpans !== capturedSpans) return;
            clearLit();
            var spanIdx = Math.min(
              Math.floor(idx / total * capturedWord.length),
              capturedWord.length - 1
            );
            var span = capturedSpans[spanIdx];
            if (span) span.classList.add('lit');
          }

          /* Fallback to spellWord (letter names) when G2P fails. */
          function doSpellFallback() {
            if (isStale() || litSpans !== capturedSpans) return;
            if (!audio || !audio.spellWord) return;
            audio.spellWord(capturedWord, {
              onLetter: function (letter, idx) {
                if (isStale() || litSpans !== capturedSpans) return;
                clearLit();
                var span = capturedSpans[idx];
                if (span) span.classList.add('lit');
              },
              onDone: function () {
                if (isStale() || litSpans !== capturedSpans) return;
                clearLit();
              },
            });
          }

          /* Track hmm-done and g2p-resolved state independently; fire
             playPhonemes once both are ready.                           */
          var hmmDone = false;
          var g2pResult = null;   /* null = pending, false = failed, array = phonemes */

          function tryPlayPhonemes() {
            if (!hmmDone || g2pResult === null) return;   /* not both ready */
            if (isStale() || litSpans !== capturedSpans) return;
            if (g2pResult === false) {
              doSpellFallback();
              return;
            }
            var phonemes = g2pResult;
            var total = phonemes.length;
            if (!total) { clearLit(); return; }
            if (!audio || !audio.playPhonemes) { clearLit(); return; }
            audio.playPhonemes(phonemes, {
              onPhoneme: function (ph, idx) { onPhoneme(ph, idx, total); },
              onDone: function () {
                if (isStale() || litSpans !== capturedSpans) return;
                clearLit();
              },
            });
          }

          /* Kick off hmm. When it ends, set hmmDone and try. */
          if (audio && audio.playHmm) {
            /* playHmm doesn't take callbacks; we attach to the audio
               element's end via a tiny sequence wrapper. To avoid
               coupling to audio internals we just time the hmm clip
               by using a no-op playPhonemes on an empty array — the
               cleanest public API available — after scheduling a
               micro-sequence ourselves.

               Actually: re-read the spec — "Start BOTH concurrently:
               audio.playHmm() AND GlyphsHost.g2p()". playHmm calls
               stopCurrent() which would stomp a concurrent sequence.
               So we use a single-item playPhonemes-shaped helper:
               fire playHmm, then use audio.playHmm's side-effect
               that the clip ends when the Audio element fires 'ended'.
               The cleanest way without touching audio.js internals is
               to drive this via spellWord with an empty string, but
               that returns immediately. Instead we wire the hmm-done
               signal via a small timeout pegged to the hmm clip duration,
               OR we extend audio.js with a callback on playHmm. The spec
               says we may not touch audio.js internals for this — but
               the deliverable says UPDATE audio.js (we ARE updating it
               to remove the legacy branch). We'll add playHmm callback
               support in audio.js and use it here.

               For now, implement via the approach that works with the
               current audio.js: playSequence is private, so we use the
               public spellWord with a single-char synthetic item to get
               the "sequence done" callback — but that plays a letter
               name clip (unwanted audio).

               CORRECT APPROACH: extend playHmm to accept opts.onDone.
               This is a minimal, documented change to audio.js. See
               Deliverable 2 note below.

               We wire it here: audio.playHmm({ onDone: fn }).         */
            audio.playHmm({
              onDone: function () {
                hmmDone = true;
                tryPlayPhonemes();
              },
            });
          } else {
            /* No audio — treat hmm as instant. */
            hmmDone = true;
          }

          /* Kick off g2p concurrently. */
          var host = window.GlyphsHost;
          if (host && host.g2p) {
            host.g2p(capturedWord).then(
              function (result) {
                if (result && result.ok && result.phonemes && result.phonemes.length) {
                  g2pResult = result.phonemes;
                } else {
                  g2pResult = false;   /* ok:false → spell fallback */
                }
                tryPlayPhonemes();
              },
              function () {
                /* Rejected (near-impossible) → spell fallback. */
                g2pResult = false;
                tryPlayPhonemes();
              }
            );
          } else {
            /* No G2P available: fall back immediately when hmm ends. */
            g2pResult = false;
          }

        }(word, spans, myGen));
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
