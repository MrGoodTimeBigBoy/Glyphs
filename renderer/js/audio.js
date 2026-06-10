/* audio.js — Glyphs Phase 2 playback engine.
   Registers as window.Glyphs.audio (merges into the manifest object set by
   audio/manifest.js; does not overwrite it).

   RULE: this file must NEVER reference window.speechSynthesis or
   SpeechSynthesisUtterance. Unknown words are sounded out from pre-rendered
   clips only — "hmm" + per-letter phonemic clips in the current voice.

   Clip path layout (relative to the renderer page):
     word clip        audio/<voice>/words/<word>.<ext>
     phonemic letter  audio/<voice>/letters-phonemic/<letter>.<ext>
     hmm              audio/<voice>/hmm.<ext>
*/

(function () {
  'use strict';

  /* ── Manifest defaults (used when manifest.js has not run yet) ─── */
  var DEFAULT_PRIMARY  = 'callirrhoe';
  var DEFAULT_EXT      = 'wav';
  var DEFAULT_VOICES   = ['callirrhoe'];

  /* Bake-off word and letter subsets per PHASE2-PLAN.md.
     Non-primary voices only carry clips for these keys.             */
  var BAKEOFF_WORDS   = ['cat', 'sun', 'apple', 'the', 'run'];
  var BAKEOFF_LETTERS = ['c', 'a', 't'];
  /* hmm is present in every voice — no need to list it here.       */

  /* Gap between letters during sound-out, in ms.
     Trimmed from 120 at the listening gate ("a shade long").         */
  var LETTER_GAP_MS = 100;

  /* ── State ────────────────────────────────────────────────────── */
  var _currentVoiceIndex = 0;
  /* Monotonically increasing token; any in-progress sequence checks
     its captured token and aborts when it no longer matches.       */
  var _seqToken = 0;
  /* Single reused Audio element (avoids GC churn for rapid plays). */
  var _audio = null;

  /* ── Helpers ──────────────────────────────────────────────────── */

  function manifest() {
    /* Read defensively; manifest.js may not have been loaded yet.  */
    return (window.Glyphs && window.Glyphs.audio && window.Glyphs.audio.manifest) || null;
  }

  function primary() {
    var m = manifest();
    return (m && m.primary) ? m.primary : DEFAULT_PRIMARY;
  }

  function ext() {
    var m = manifest();
    return (m && m.ext) ? m.ext : DEFAULT_EXT;
  }

  function voices() {
    var m = manifest();
    return (m && m.voices && m.voices.length) ? m.voices : DEFAULT_VOICES;
  }

  function knownWords() {
    var m = manifest();
    return (m && m.words) ? m.words : [];
  }

  function bakeoffWords() {
    var m = manifest();
    return (m && m.bakeoffWords) ? m.bakeoffWords : BAKEOFF_WORDS;
  }

  /* voiceForClip(kind, key) — per-clip voice fallback rule.
     Non-primary voices only carry the bake-off subset. For any clip
     that is not in that subset, fall back to the primary voice.

     kind: 'word' | 'letter' | 'hmm'
     key:  the word string, or the letter character, or '' for hmm.  */
  function voiceForClip(kind, key) {
    var cur = currentVoice();
    if (cur === primary()) {
      return cur;   /* primary always has everything */
    }
    /* Non-primary: check subset membership. */
    if (kind === 'hmm') {
      return cur;   /* hmm is present in every voice */
    }
    if (kind === 'word') {
      var bw = bakeoffWords();
      for (var i = 0; i < bw.length; i++) {
        if (bw[i] === key) return cur;
      }
      return primary();
    }
    if (kind === 'letter') {
      for (var j = 0; j < BAKEOFF_LETTERS.length; j++) {
        if (BAKEOFF_LETTERS[j] === key) return cur;
      }
      return primary();
    }
    return primary();
  }

  function clipUrl(kind, key) {
    var voice = voiceForClip(kind, key);
    var e = ext();
    if (kind === 'word')   return 'audio/' + voice + '/words/' + key + '.' + e;
    if (kind === 'letter') return 'audio/' + voice + '/letters-phonemic/' + key + '.' + e;
    if (kind === 'hmm')    return 'audio/' + voice + '/hmm.' + e;
    return null;
  }

  /* ── Voice cycling ────────────────────────────────────────────── */

  function currentVoice() {
    var v = voices();
    /* Clamp index in case voices shrank after a manifest reload.   */
    if (_currentVoiceIndex >= v.length) { _currentVoiceIndex = 0; }
    return v[_currentVoiceIndex];
  }

  function cycleVoice() {
    var v = voices();
    _currentVoiceIndex = (_currentVoiceIndex + 1) % v.length;
    return currentVoice();
  }

  /* ── Public: isKnownWord ──────────────────────────────────────── */

  function isKnownWord(word) {
    var w = (word || '').toLowerCase().trim();
    var kw = knownWords();
    for (var i = 0; i < kw.length; i++) {
      if (kw[i] === w) return true;
    }
    return false;
  }

  /* ── Playback core ────────────────────────────────────────────── */

  /* getOrCreateAudio() — reuse a single HTMLAudioElement.          */
  function getOrCreateAudio() {
    if (!_audio) {
      _audio = new Audio();
    }
    return _audio;
  }

  /* stopCurrent() — abort whatever is playing/scheduled right now.
     Increments the sequence token so any pending callbacks bail.   */
  function stopCurrent() {
    _seqToken += 1;
    var a = _audio;
    if (a) {
      a.pause();
      a.src = '';
      /* Remove all transient listeners by replacing the element.
         Simpler than tracking each handler reference.              */
      _audio = null;
    }
  }

  /* playUrl(url, myToken, onEnded, onError) — load + play one clip.
     Calls onEnded when it finishes, onError if the load fails.
     Both callbacks are guarded by myToken so stale sequences bail.  */
  function playUrl(url, myToken, onEnded, onError) {
    if (myToken !== _seqToken) return;   /* superseded */

    var a = getOrCreateAudio();

    function handleEnded() {
      a.removeEventListener('ended', handleEnded);
      a.removeEventListener('error', handleError);
      if (myToken !== _seqToken) return; /* superseded */
      onEnded();
    }

    function handleError(ev) {
      a.removeEventListener('ended', handleEnded);
      a.removeEventListener('error', handleError);
      console.warn('Glyphs.audio: failed to load clip:', url, ev);
      if (myToken !== _seqToken) return; /* superseded */
      onError();
    }

    a.addEventListener('ended', handleEnded);
    a.addEventListener('error', handleError);
    a.src = url;
    a.load();
    var playPromise = a.play();
    /* play() returns a Promise in modern Chromium; swallow rejection
       so the console stays quiet when a clip is absent.            */
    if (playPromise && typeof playPromise.then === 'function') {
      playPromise.then(null, function () { /* silenced — error fires */ });
    }
  }

  /* playSequence(items, myToken, opts, idx)
     items: array of { kind, key } objects
     Plays items[idx] then recurses, honouring LETTER_GAP_MS between
     items. opts.onLetter(letter, idx) called before each letter item.
     opts.onDone() called when the whole sequence completes.          */
  function playSequence(items, myToken, opts, idx) {
    if (myToken !== _seqToken) return;
    if (idx >= items.length) {
      if (opts.onDone) opts.onDone();
      return;
    }

    var item = items[idx];
    var url = clipUrl(item.kind, item.key);

    if (opts.onLetter && item.kind === 'letter') {
      opts.onLetter(item.key, idx);
    }

    function advance() {
      if (myToken !== _seqToken) return;
      var next = idx + 1;
      if (next >= items.length) {
        if (opts.onDone) opts.onDone();
        return;
      }
      /* Small gap between letters; no gap after "hmm" (word clip). */
      if (item.kind === 'letter') {
        setTimeout(function () {
          playSequence(items, myToken, opts, next);
        }, LETTER_GAP_MS);
      } else {
        playSequence(items, myToken, opts, next);
      }
    }

    playUrl(url, myToken, advance, advance /* on error: advance anyway */);
  }

  /* ── play(word, opts) — the public API ───────────────────────── */
  /*
     Decision logic:
       1. Normalise: lowercase + trim.
       2. Empty or contains any non a–z character → do nothing; return
          { type: 'junk' }. No audio, no TTS.
       3. isKnownWord → play single word clip; return { type: 'word' }.
       4. All-alpha but unknown → play "hmm", then each letter's
          phonemic clip in sequence with LETTER_GAP_MS gaps;
          return { type: 'soundout', letters: [...] }.

     opts (all optional):
       onLetter(letter, idx)  — called before each phonemic letter clip
       onDone()               — called when the sequence finishes
  */
  function play(word, opts) {
    opts = opts || {};
    var w = (word || '').toLowerCase().trim();

    /* Guard: empty or non-alpha → junk, play nothing. */
    if (!w || !/^[a-z]+$/.test(w)) {
      return { type: 'junk' };
    }

    /* Stop and supersede any in-progress sequence. */
    stopCurrent();
    var myToken = _seqToken;

    if (isKnownWord(w)) {
      /* ── Known word path ──────────────────────────────────────── */
      var url = clipUrl('word', w);
      playUrl(url, myToken,
        function () { if (opts.onDone) opts.onDone(); },
        function () { if (opts.onDone) opts.onDone(); }
      );
      return { type: 'word' };
    }

    /* ── Unknown all-alpha word: hmm + phonemic letters ────────── */
    var letters = w.split('');
    var items = [{ kind: 'hmm', key: '' }];
    for (var i = 0; i < letters.length; i++) {
      items.push({ kind: 'letter', key: letters[i] });
    }
    playSequence(items, myToken, opts, 0);
    return { type: 'soundout', letters: letters };
  }

  /* ── Register ─────────────────────────────────────────────────── */

  window.Glyphs.register('audio', {
    init: function () {
      /* Merge the play API into window.Glyphs.audio without clobbering
         the manifest data that manifest.js may have already set.    */
      window.Glyphs.audio = window.Glyphs.audio || {};

      window.Glyphs.audio.getVoices      = voices;
      window.Glyphs.audio.getCurrentVoice = currentVoice;
      window.Glyphs.audio.cycleVoice     = cycleVoice;
      window.Glyphs.audio.isKnownWord    = isKnownWord;
      window.Glyphs.audio.play           = play;

      /* Seed the current-voice index to point at the manifest primary. */
      var v = voices();
      var p = primary();
      for (var i = 0; i < v.length; i++) {
        if (v[i] === p) { _currentVoiceIndex = i; break; }
      }
    },
  });

}());
