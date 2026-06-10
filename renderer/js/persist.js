/* persist.js — Glyphs Phase 3 history persistence.
   Registers as window.Glyphs.persist; wraps the GlyphsHost preload
   bridge (loadHistory / saveHistory → userData/history.json in main).

   Defensive by design: if the bridge is missing (test-audio.html never
   loads this file, but belt-and-braces) every call silently no-ops, so
   the hub works in-memory either way. Saves are debounced ~500 ms so a
   typing burst costs one write.
*/

(function () {
  'use strict';

  var SAVE_DEBOUNCE_MS = 500;

  var _saveTimer = null;

  function host() {
    return window.GlyphsHost || null;
  }

  /* load(cb) — fetch persisted entries; cb(array) always fires, always
     asynchronously, with [] on any failure.                           */
  function load(cb) {
    var h = host();
    if (!h || typeof h.loadHistory !== 'function') {
      setTimeout(function () { cb([]); }, 0);
      return;
    }
    try {
      h.loadHistory().then(
        function (entries) { cb(Array.isArray(entries) ? entries : []); },
        function () { cb([]); }
      );
    } catch (err) {
      setTimeout(function () { cb([]); }, 0);
    }
  }

  /* save(entries) — debounced; only the latest snapshot in a burst is
     written. Entries are copied at call time (the hub mutates its array
     in place). Failures are silent — main returns {ok:false}, never
     throws across the bridge.                                         */
  function save(entries) {
    var snapshot = Array.isArray(entries) ? entries.slice() : [];
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function () {
      var h = host();
      if (!h || typeof h.saveHistory !== 'function') return;
      try {
        var p = h.saveHistory(snapshot);
        if (p && typeof p.then === 'function') {
          p.then(null, function () { /* silent */ });
        }
      } catch (err) { /* silent */ }
    }, SAVE_DEBOUNCE_MS);
  }

  window.Glyphs.register('persist', {
    init: function () {
      window.Glyphs.persist = {
        load: load,
        save: save,
      };
    },
  });

}());
