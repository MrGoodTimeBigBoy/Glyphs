/* audio.js — Glyphs Phase 2 playback engine.
   Registers as window.Glyphs.audio (merges into the manifest object set by
   audio/manifest.js; does not overwrite it).

   RULE: this file must NEVER reference window.speechSynthesis or
   SpeechSynthesisUtterance. Everything is pre-rendered clips. Unknown
   words are handled by hub.js via G2P + playPhonemes (speak mode) or
   spellWord (spell mode) — never directly by this engine; play() itself
   speaks known words only.

   Clip path layout (relative to the renderer page):
     word clip        audio/<voice>/words/<word>.<ext>
     phoneme clip     audio/<voice>/phonemes/<arpabet>.<ext>
     phonemic letter  audio/<voice>/letters-phonemic/<letter>.<ext>
     letter name      audio/<voice>/letters-name/<letter>.<ext>
     hmm              audio/<voice>/hmm.<ext>
     deflate          audio/<voice>/deflate.<ext>
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

  /* Gap between letter-names in spellWord(), in ms.
     Letter names are full syllables ("see", "ay", "tee") — they need
     more air than the phonemic letter-sound gap.  Ear-tune candidate. */
  var LETTER_NAME_GAP_MS = 140;

  /* Inter-phoneme gap table for playPhonemes(), in ms.
     These are ear-tuning candidates — change here AND keep audio.js
     and tools/tts/test_phonemes.py in lockstep.
     Classes follow standard ARPABET articulatory groupings.          */
  var PHONEME_GAPS = {
    /* stops */
    B: 30, D: 30, G: 30, K: 30, P: 30, T: 30,
    /* affricates */
    CH: 40, JH: 40,
    /* vowels */
    AA: 60, AE: 60, AH: 60, AO: 60, AW: 60, AY: 60,
    EH: 60, ER: 60, EY: 60, IH: 60, IY: 60,
    OW: 60, OY: 60, UH: 60, UW: 60,
    /* default (fricatives / nasals / liquids / glides): 50 ms */
  };
  var PHONEME_GAP_DEFAULT_MS = 50;

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

     kind: 'word' | 'letter' | 'lettername' | 'hmm' | 'deflate'
     key:  the word string, or the letter character, or '' for hmm/deflate. */
  function voiceForClip(kind, key) {
    if (kind === 'lettername') {
      return primary();   /* letter-name clips exist only in the primary voice */
    }
    var cur = currentVoice();
    if (cur === primary()) {
      return cur;   /* primary always has everything */
    }
    /* Non-primary: check subset membership. */
    if (kind === 'hmm' || kind === 'deflate') {
      return cur;   /* hmm and deflate are present in every voice */
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
    if (kind === 'word')     return 'audio/' + voice + '/words/' + key + '.' + e;
    if (kind === 'letter')   return 'audio/' + voice + '/letters-phonemic/' + key + '.' + e;
    if (kind === 'lettername') return 'audio/' + voice + '/letters-name/' + key + '.' + e;
    if (kind === 'phoneme')  return 'audio/' + primary() + '/phonemes/' + key.toLowerCase() + '.' + e;
    if (kind === 'hmm')      return 'audio/' + voice + '/hmm.' + e;
    if (kind === 'deflate')  return 'audio/' + voice + '/deflate.' + e;
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

  /* gapForItem(item) — return the inter-item gap in ms.
     0 = immediate advance (e.g. after hmm before the letter sequence). */
  function gapForItem(item) {
    if (item.kind === 'lettername') return LETTER_NAME_GAP_MS;
    if (item.kind === 'phoneme') {
      var ph = (item.key || '').toUpperCase();
      return (PHONEME_GAPS[ph] !== undefined) ? PHONEME_GAPS[ph] : PHONEME_GAP_DEFAULT_MS;
    }
    return 0;   /* hmm, word — no inter-item gap */
  }

  /* playSequence(items, myToken, opts, idx)
     items: array of { kind, key } objects
     Plays items[idx] then recurses, honouring per-kind gaps between
     items.

     Supported item kinds: 'lettername', 'phoneme', 'hmm', 'word'.

     Callback dispatch:
       opts.onLetter(key, idx)   — before each 'lettername' item
       opts.onPhoneme(key, idx)  — before each 'phoneme' item
       opts.onDone()             — when the whole sequence completes   */
  function playSequence(items, myToken, opts, idx) {
    if (myToken !== _seqToken) return;
    if (idx >= items.length) {
      if (opts.onDone) opts.onDone();
      return;
    }

    var item = items[idx];
    var url = clipUrl(item.kind, item.key);

    if (opts.onLetter && item.kind === 'lettername') {
      opts.onLetter(item.key, idx);
    }
    if (opts.onPhoneme && item.kind === 'phoneme') {
      opts.onPhoneme(item.key, idx);
    }

    function advance() {
      if (myToken !== _seqToken) return;
      var next = idx + 1;
      if (next >= items.length) {
        if (opts.onDone) opts.onDone();
        return;
      }
      var gap = gapForItem(item);
      if (gap > 0) {
        setTimeout(function () {
          playSequence(items, myToken, opts, next);
        }, gap);
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
       4. Unknown all-alpha word → log a warning and call onDone so
          callers never hang. Unknown-word audio is handled in hub.js
          via G2P + playPhonemes (speak mode) or spellWord (spell mode);
          play() is intentionally known-words-only now.

     opts (all optional):
       onDone()  — called when the clip finishes (or immediately if the
                   word is unknown, so callers never stall)
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

    /* Unknown word: the legacy grapheme sound-out has been removed.
       Unknown-word audio is now handled by hub.js (G2P + playPhonemes
       in speak mode; spellWord in spell mode). Fire onDone so callers
       never hang, and log so any accidental call here is visible.     */
    console.warn('Glyphs.audio.play: called with unknown word "' + w +
                 '" — use playPhonemes or spellWord for unknown words.');
    if (opts.onDone) opts.onDone();
    return { type: 'unknown' };
  }

  /* ── playPhonemes(phonemes, opts) ────────────────────────────── */
  /*
     Speak mode: plays renderer/audio/callirrhoe/phonemes/<ph>.wav for
     each ARPABET phoneme in the array, with per-class inter-phoneme
     gaps (PHONEME_GAPS / PHONEME_GAP_DEFAULT_MS).

     phonemes: array of ARPABET symbols e.g. ['SH', 'AA', 'P']
               (case-normalised internally).

     opts (all optional):
       onPhoneme(ph, idx)  — called before each phoneme clip starts;
                             ph is the normalised uppercase symbol,
                             idx is its position in the array (0-based).
       onDone()            — called when the last clip ends.

     Reuses the shared playSequence machinery; supersedes any in-flight
     audio.
  */
  function playPhonemes(phonemes, opts) {
    opts = opts || {};
    if (!phonemes || !phonemes.length) {
      if (opts.onDone) opts.onDone();
      return;
    }
    stopCurrent();
    var myToken = _seqToken;
    var items = [];
    for (var i = 0; i < phonemes.length; i++) {
      items.push({ kind: 'phoneme', key: (phonemes[i] || '').toUpperCase() });
    }
    playSequence(items, myToken, opts, 0);
  }

  /* ── spellWord(word, opts) ────────────────────────────────────── */
  /*
     Spell mode: plays the letter-name clip (letters-name/<letter>.wav)
     for each a–z character of the word in order, with LETTER_NAME_GAP_MS
     between each letter name.

     Non a–z characters are silently skipped (spaces, digits, hyphens,
     etc. — this keeps the function safe for any word the hub hands it).

     opts (all optional):
       onLetter(letter, idx)  — called before each letter-name clip;
                                letter is the lowercase character,
                                idx is its position in the original word
                                (0-based, counting ALL characters including
                                skipped ones) so callers can highlight the
                                right position in a displayed word.
       onDone()               — called when the last clip ends.
  */
  function spellWord(word, opts) {
    opts = opts || {};
    var w = (word || '').toLowerCase();
    if (!w) {
      if (opts.onDone) opts.onDone();
      return;
    }
    stopCurrent();
    var myToken = _seqToken;
    var items = [];
    for (var i = 0; i < w.length; i++) {
      var ch = w[i];
      if (/^[a-z]$/.test(ch)) {
        /* Wrap the per-character index in a closure so onLetter reports
           the position in the original word, not just the a–z subset.  */
        items.push({ kind: 'lettername', key: ch, wordIdx: i });
      }
    }
    if (!items.length) {
      if (opts.onDone) opts.onDone();
      return;
    }
    /* Adapt opts: spellWord exposes onLetter(letter, wordIdx); playSequence
       dispatches opts.onLetter(key, seqIdx).  We bridge with a wrapper.  */
    var adaptedOpts = {
      onDone: opts.onDone,
    };
    if (opts.onLetter) {
      adaptedOpts.onLetter = function (key, seqIdx) {
        /* seqIdx is position within items[]; items[seqIdx].wordIdx is
           the position in the original word string.                    */
        var wordIdx = (items[seqIdx] && items[seqIdx].wordIdx !== undefined)
          ? items[seqIdx].wordIdx
          : seqIdx;
        opts.onLetter(key, wordIdx);
      };
    }
    playSequence(items, myToken, adaptedOpts, 0);
  }

  /* ── playLetterSound(letter) — single phonemic letter clip ───── */
  /*
     Convenience wrapper: plays the phonemic letter clip for a single
     a–z character from letters-phonemic/ — the hide world's speak-mode
     announcement. Sibling of playLetterName.
  */
  function playLetterSound(letter) {
    var l = (letter || '').toLowerCase();
    if (!/^[a-z]$/.test(l)) return;
    stopCurrent();
    var myToken = _seqToken;
    playUrl(clipUrl('letter', l), myToken,
      function () { /* nothing more to do when it ends */ },
      function () { /* missing clip — playUrl already warned */ }
    );
  }

  /* ── playLetterName(letter) — single letter-name clip ────────── */
  /*
     Phase 4 find world: a successful catch speaks the letter's NAME
     ("see", "ay", "tee" — letters-name/, not the phonemic set). Same
     token/stop machinery as everything else, so rapid catches simply
     supersede each other. A missing clip fails silently.
  */
  function playLetterName(letter) {
    var l = (letter || '').toLowerCase();
    if (!/^[a-z]$/.test(l)) return;
    stopCurrent();
    var myToken = _seqToken;
    playUrl(clipUrl('lettername', l), myToken,
      function () { /* nothing more to do when it ends */ },
      function () { /* missing clip — playUrl already warned */ }
    );
  }

  /* ── playHmm(opts) — the thinking sound ──────────────────────── */
  /*
     Phase 5 hide world (hider mode): the machine "hmm"s while it
     theatrically searches.

     Phase 6 hub speak mode: hub.js uses playHmm concurrently with
     GlyphsHost.g2p() to cover G2P latency; opts.onDone is called once
     the hmm clip ends so hub.js knows when it can start phonemes.

     opts (all optional):
       onDone()  — called when the hmm clip ends (or immediately if
                   the clip is missing), so callers can chain work.
  */
  function playHmm(opts) {
    opts = opts || {};
    stopCurrent();
    var myToken = _seqToken;
    playUrl(clipUrl('hmm', ''), myToken,
      function () { if (opts.onDone) opts.onDone(); },
      function () { if (opts.onDone) opts.onDone(); /* missing clip — fire anyway */ }
    );
  }

  /* ── playDeflate() — junk-input deflate clip ─────────────────── */
  /*
     Phase 3 hub: junk input gets a small "pfff". Goes through the same
     token/stop machinery as everything else, so it supersedes (and is
     superseded by) any in-progress sequence. A missing clip is a silent
     failure — playUrl console.warns and nothing plays.
  */
  function playDeflate() {
    stopCurrent();
    var myToken = _seqToken;
    playUrl(clipUrl('deflate', ''), myToken,
      function () { /* nothing more to do when it ends */ },
      function () { /* missing clip — playUrl already warned */ }
    );
  }

  /* ── Register ─────────────────────────────────────────────────── */

  window.Glyphs.register('audio', {
    init: function () {
      /* Merge the play API into window.Glyphs.audio without clobbering
         the manifest data that manifest.js may have already set.    */
      window.Glyphs.audio = window.Glyphs.audio || {};

      window.Glyphs.audio.getVoices       = voices;
      window.Glyphs.audio.getCurrentVoice = currentVoice;
      window.Glyphs.audio.cycleVoice      = cycleVoice;
      window.Glyphs.audio.isKnownWord     = isKnownWord;
      window.Glyphs.audio.play            = play;
      window.Glyphs.audio.playDeflate     = playDeflate;
      window.Glyphs.audio.playLetterName  = playLetterName;
      window.Glyphs.audio.playLetterSound = playLetterSound;
      window.Glyphs.audio.playHmm         = playHmm;
      window.Glyphs.audio.playPhonemes    = playPhonemes;
      window.Glyphs.audio.spellWord       = spellWord;

      /* Seed the current-voice index to point at the manifest primary. */
      var v = voices();
      var p = primary();
      for (var i = 0; i < v.length; i++) {
        if (v[i] === p) { _currentVoiceIndex = i; break; }
      }
    },
  });

}());
