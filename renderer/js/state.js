/* state.js — Glyphs Phase 3 top-level state machine.
   Registers as window.Glyphs.state.

   States: 'hub' | 'hide' | 'draw' | 'find'. The hub registers itself
   (hub.js); the three worlds are STUBS owned by this file — a centered
   dim line "would enter <name> world" replacing the hub view.

   Keyboard ownership: ONE document-level keydown listener lives here and
   routes every key. ESC is handled HERE and nowhere else — in a world it
   returns to the hub; in the hub it does nothing. containment.js (both)
   never touches ESC. Everything else is forwarded to the current state's
   onKey handler; in a world stub, non-ESC keys produce a tiny visual
   ping (DESIGN: mashing is absorbed, never punished).

   World shape: registerWorld(name, { enter, exit, onKey }). enter/exit
   manage that state's own DOM visibility; onKey(e) receives the raw
   keydown event (modifier chords are filtered out before routing).
*/

(function () {
  'use strict';

  var STUB_WORLDS = ['hide', 'draw', 'find'];

  /* ── State ────────────────────────────────────────────────────── */
  var _current = 'hub';
  var _worlds  = {};      /* name → { enter, exit, onKey } */

  /* Stub DOM refs (resolved at init). */
  var _stubEl     = null;
  var _stubLineEl = null;

  /* ── Public API ───────────────────────────────────────────────── */

  function current() {
    return _current;
  }

  function registerWorld(name, world) {
    if (_worlds[name]) {
      console.warn('Glyphs.state.registerWorld: duplicate "' + name + '" — ignoring');
      return;
    }
    _worlds[name] = world || {};
  }

  function go(name) {
    if (name === _current) return;
    if (!_worlds[name]) {
      console.warn('Glyphs.state.go: unknown state "' + name + '" — ignoring');
      return;
    }
    var leaving = _worlds[_current];
    if (leaving && leaving.exit) leaving.exit();
    _current = name;
    var entering = _worlds[name];
    if (entering.enter) entering.enter();
  }

  /* ── World stubs ──────────────────────────────────────────────── */

  /* ping() — tiny visual response to a non-ESC key inside a stub:
     the stub line flashes bright for a beat. Re-triggerable by forcing
     a reflow between class removal and re-add.                      */
  function ping() {
    if (!_stubLineEl) return;
    _stubLineEl.classList.remove('ping');
    void _stubLineEl.offsetWidth;   /* restart the CSS animation */
    _stubLineEl.classList.add('ping');
  }

  function makeStub(name) {
    return {
      enter: function () {
        if (_stubLineEl) _stubLineEl.textContent = 'would enter ' + name + ' world';
        if (_stubEl) _stubEl.hidden = false;
      },
      exit: function () {
        if (_stubEl) _stubEl.hidden = true;
        if (_stubLineEl) _stubLineEl.classList.remove('ping');
      },
      onKey: function (e) {
        /* ESC never reaches here (handled in the router). Everything
           else is absorbed with a small acknowledgment.             */
        e.preventDefault();
        ping();
      },
    };
  }

  /* ── Keydown router ───────────────────────────────────────────── */

  function onKeydown(e) {
    /* Chords belong to the cage (main-process interceptor). */
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    /* ESC: world → hub; hub → nothing. Handled here ONLY. */
    if (e.key === 'Escape') {
      e.preventDefault();
      if (_current !== 'hub') go('hub');
      return;
    }

    var w = _worlds[_current];
    if (w && w.onKey) w.onKey(e);
  }

  /* ── Register ─────────────────────────────────────────────────── */

  window.Glyphs.register('state', {
    init: function () {
      _stubEl     = document.getElementById('world-stub');
      _stubLineEl = document.getElementById('world-stub-line');

      for (var i = 0; i < STUB_WORLDS.length; i++) {
        registerWorld(STUB_WORLDS[i], makeStub(STUB_WORLDS[i]));
      }

      document.addEventListener('keydown', onKeydown);

      window.Glyphs.state = {
        current: current,
        go: go,
        registerWorld: registerWorld,
      };
    },
  });

}());
