/* mode.js — Glyphs global speak/spell mode.
   Registers as window.Glyphs.mode.

   Two modes affect audio policy and color identity app-wide:
     speak  (default) — phonics, phosphor green
     spell            — spelling bee, amber

   API:
     current()      → 'speak' | 'spell'
     set(mode)      → no-op if already current; otherwise swap body class,
                      persist, and notify subscribers.
     onChange(cb)   → subscribe; cb(mode) called after every switch.

   On init: load persisted mode and apply it silently (no announcement).
   The HTML default is mode-speak; if stored mode is spell the body class
   is swapped without any audio.
*/

(function () {
  'use strict';

  var _current     = 'speak';
  var _subscribers = [];

  function isValidMode(m) {
    return m === 'speak' || m === 'spell';
  }

  /* ── Body class swap ─────────────────────────────────────────────── */

  function applyBodyClass(mode) {
    document.body.classList.remove('mode-speak', 'mode-spell');
    document.body.classList.add('mode-' + mode);
  }

  /* ── Flux transition (short one-shot class so elements ease color) ─ */
  /* Uses universal selector in CSS — see styles.css mode-flux block.
     We remove the class after 600 ms so ongoing keyframe animations
     are not permanently damped.                                        */

  var _fluxTimer = null;

  function triggerFlux() {
    if (_fluxTimer) {
      clearTimeout(_fluxTimer);
      document.body.classList.remove('mode-flux');
      void document.body.offsetWidth;   /* force reflow to restart */
    }
    document.body.classList.add('mode-flux');
    _fluxTimer = setTimeout(function () {
      document.body.classList.remove('mode-flux');
      _fluxTimer = null;
    }, 600);
  }

  /* ── Persistence ────────────────────────────────────────────────── */

  function host() {
    return window.GlyphsHost || null;
  }

  function persistMode(mode) {
    var h = host();
    if (!h || typeof h.saveMode !== 'function') return;
    try {
      var p = h.saveMode(mode);
      if (p && typeof p.then === 'function') {
        p.then(null, function () { /* silent */ });
      }
    } catch (err) { /* silent */ }
  }

  /* ── Subscribers ────────────────────────────────────────────────── */

  function notify(mode) {
    for (var i = 0; i < _subscribers.length; i++) {
      try { _subscribers[i](mode); } catch (e) { /* never break the caller */ }
    }
  }

  /* ── Public API ─────────────────────────────────────────────────── */

  function current() {
    return _current;
  }

  function set(mode) {
    if (!isValidMode(mode)) return;
    if (mode === _current) return;
    _current = mode;
    triggerFlux();
    applyBodyClass(mode);
    persistMode(mode);
    notify(mode);
  }

  function onChange(cb) {
    if (typeof cb === 'function') _subscribers.push(cb);
  }

  /* ── Register ───────────────────────────────────────────────────── */

  window.Glyphs.register('mode', {
    init: function () {
      /* Load persisted mode; apply silently (no announcement on startup). */
      var h = host();
      if (h && typeof h.loadMode === 'function') {
        try {
          h.loadMode().then(
            function (m) {
              if (isValidMode(m) && m !== _current) {
                _current = m;
                applyBodyClass(m);   /* silent — no flux, no notify */
              }
            },
            function () { /* missing or unreadable — stay on default */ }
          );
        } catch (err) { /* silent */ }
      }

      window.Glyphs.mode = {
        current: current,
        set: set,
        onChange: onChange,
      };
    },
  });

}());
