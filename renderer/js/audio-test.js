/* audio-test.js — Glyphs Phase 2 typing-test harness UI.
   Registers as window.Glyphs.audioTest.

   Keyboard contract:
     a–z / A–Z      append lowercased letter to buffer
     Backspace      delete last character
     Enter          submit buffer → play, echo result, clear buffer
     Tab            cycle voice (preventDefault to suppress focus jump)
     Escape         LEFT UNBOUND — reserved for future return-to-hub
     Ctrl/Cmd/Alt   ignored (pass-through to cage/OS)
*/

(function () {
  'use strict';

  var MAX_HISTORY = 5;   /* number of history entries to keep visible */

  window.Glyphs.register('audioTest', {
    init: function () {

      /* ── DOM refs ──────────────────────────────────────────── */
      var voiceLabel   = document.getElementById('voice-label');
      var statusLine   = document.getElementById('status-line');
      var inputBuffer  = document.getElementById('input-buffer');
      var historyList  = document.getElementById('history-list');

      /* ── Buffer state ──────────────────────────────────────── */
      var buffer = '';

      /* ── History (oldest first) ────────────────────────────── */
      var history = [];   /* [{ word, result }] */

      /* ── UI helpers ────────────────────────────────────────── */

      function renderVoice() {
        var audio = window.Glyphs.audio;
        voiceLabel.textContent = (audio && audio.getCurrentVoice)
          ? audio.getCurrentVoice()
          : 'sulafat';
      }

      function renderBuffer() {
        inputBuffer.textContent = buffer;
      }

      function setStatus(html) {
        statusLine.innerHTML = html;
      }

      function renderHistory() {
        while (history.length > MAX_HISTORY) {
          history.shift();
        }
        historyList.innerHTML = '';
        for (var i = 0; i < history.length; i++) {
          var entry = history[i];
          var row   = document.createElement('div');
          row.className = 'h-entry';

          var wordEl = document.createElement('span');
          wordEl.className = 'h-word';
          wordEl.textContent = entry.word;

          var resEl = document.createElement('span');
          resEl.className = 'h-result';
          resEl.textContent = entry.result;

          row.appendChild(wordEl);
          row.appendChild(resEl);
          historyList.appendChild(row);
        }
      }

      /* buildLetterStatusHTML(letters, litIdx)
         Renders the sound-out status line with phosphor highlights.
         litIdx === -1  → no letter highlighted (initial/done state).
         litIdx >= 0    → that letter index is "lit" (currently playing). */
      function buildLetterStatusHTML(letters, litIdx) {
        var parts = [];
        for (var i = 0; i < letters.length; i++) {
          if (i === litIdx) {
            parts.push('<span class="lit">' + letters[i] + '</span>');
          } else {
            parts.push(letters[i]);
          }
        }
        return 'hmm… ' + parts.join('-');
      }

      /* ── Submit a word ─────────────────────────────────────── */

      function submit() {
        if (!buffer) return;

        var word = buffer;
        buffer = '';
        renderBuffer();

        var audio = window.Glyphs.audio;
        if (!audio || !audio.play) {
          setStatus('(audio not ready)');
          history.push({ word: word, result: '(audio not ready)' });
          renderHistory();
          return;
        }

        /* Probe the word type first (play() is synchronous for type
           determination; audio starts as a side-effect).
           We need to know the type to build the right callbacks, so we
           check isKnownWord before calling play() to choose callbacks,
           then call play() exactly once with the correct ones.        */
        var isJunk  = !word || !/^[a-z]+$/.test(word.toLowerCase().trim());
        var isKnown = !isJunk && audio.isKnownWord && audio.isKnownWord(word);

        if (isJunk) {
          /* play() is still called so the engine's guard runs; result
             will be { type: 'junk' }. No audio fires.                */
          audio.play(word);
          setStatus('(nothing)');
          history.push({ word: word, result: '(nothing — not a–z)' });
          renderHistory();
          return;
        }

        if (isKnown) {
          audio.play(word, {
            onDone: function () { /* status already set below */ },
          });
          setStatus('spoke: ' + word);
          history.push({ word: word, result: 'spoke' });
          renderHistory();
          return;
        }

        /* Unknown all-alpha: build letter array, set initial status,
           then play once with live onLetter/onDone callbacks.        */
        var letters = word.toLowerCase().trim().split('');
        setStatus(buildLetterStatusHTML(letters, -1));

        audio.play(word, {
          onLetter: function (letter) {
            /* Highlight the first occurrence of this letter.         */
            var litIdx = letters.indexOf(letter);
            setStatus(buildLetterStatusHTML(letters, litIdx));
          },
          onDone: function () {
            /* Remove highlight when sequence finishes.               */
            setStatus(buildLetterStatusHTML(letters, -1));
          },
        });

        history.push({ word: word, result: 'hmm… ' + letters.join('-') });
        renderHistory();
      }

      /* ── Keyboard handler ──────────────────────────────────── */

      document.addEventListener('keydown', function (e) {
        /* Let the cage handle anything with a modifier key. */
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        var key = e.key;

        /* Tab → cycle voice; prevent the native focus-jump. */
        if (key === 'Tab') {
          e.preventDefault();
          var audio = window.Glyphs.audio;
          if (audio && audio.cycleVoice) {
            audio.cycleVoice();
            renderVoice();
          }
          return;
        }

        /* Enter → submit current buffer. */
        if (key === 'Enter') {
          submit();
          return;
        }

        /* Backspace → delete last character. */
        if (key === 'Backspace') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            renderBuffer();
          }
          return;
        }

        /* a–z / A–Z → append as lowercase. */
        if (key.length === 1 && /^[a-zA-Z]$/.test(key)) {
          buffer += key.toLowerCase();
          renderBuffer();
          return;
        }

        /* Escape, F-keys, arrows, digits, etc. → silently ignored. */
      });

      /* ── Voice indicator click → also cycles the voice ─────── */

      var voiceEl = document.querySelector('.harness-voice');
      if (voiceEl) {
        voiceEl.addEventListener('click', function () {
          var audio = window.Glyphs.audio;
          if (audio && audio.cycleVoice) {
            audio.cycleVoice();
            renderVoice();
          }
        });
      }

      /* ── Initial render ────────────────────────────────────── */

      renderVoice();
      renderBuffer();
      setStatus(' ');   /* non-breaking space preserves line height */
    },
  });

}());
