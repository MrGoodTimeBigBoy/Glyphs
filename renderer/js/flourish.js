/* flourish.js — Glyphs Phase 3 decorated-word flourishes.
   Registers as window.Glyphs.flourish: { play(word), has(word) }.

   Eleven small ASCII sketches (the DESIGN.md starters), each 1–3 s,
   drawn into a dedicated absolutely-positioned, pointer-events-none
   layer — they never block typing and never touch the audio engine.
   One flourish at a time: a new play() replaces the current one.

   Engine: a single <pre> sprite stepped by requestAnimationFrame.
   Each sketch is a frame function (t, ms, w, h, a) that positions
   pre-authored ASCII text; t is 0→1 progress, w/h the viewport, a the
   active-run record (carries the input-line anchor for mom/dad).
*/

(function () {
  'use strict';

  /* ── Sprite frames ────────────────────────────────────────────── */

  var CAT = [
    ' /\\_/\\\n( o.o )\n  |  |',
    ' /\\_/\\\n( o.o )\n  /  \\',
  ];

  var DOG = [
    '    __\n\\__(o.o)\n   |  |',
    '    __\n/__(o.o)\n   |  |',
  ];

  var SUN = ' \\ | /\n-- O --\n / | \\';

  var MOON = [
    '*    _\n    ( \n     \\_    .',
    '.    _\n    ( \n     \\_    *',
  ];

  var TREE = [
    '.',
    ' ,\n |',
    '\\|/\n |',
    '  ^\n /|\\\n//|\\\\\n  |',
  ];

  var STAR = ['.', '+', '*', '\\ /\n-*-\n/ \\', '*', '+', '.'];

  /* Rain column: rows cycle downward as the run advances. */
  var RAIN = [
    "  '  .  ",
    '. /   / ',
    "  .  '  ",
    " /  .  /",
    "'   /  .",
    ' . /  / ',
  ];

  var FISH = [
    '   o  .\n><(((*>',
    ' .  o\n><(((*>',
  ];

  var BIRD = ['v   v', '^   ^'];

  var HEART = '<3';

  /* ── Engine state ─────────────────────────────────────────────── */

  var _layer  = null;
  var _sprite = null;
  var _active = null;   /* { def, start, anchorX, anchorY } */
  var _raf    = 0;

  /* setSprite(text, x, y, opts) — position the sprite, center-anchored.
     opts: { dim, scale, opacity } — all optional.                     */
  function setSprite(text, x, y, opts) {
    opts = opts || {};
    _sprite.textContent = text;
    _sprite.style.left = Math.round(x) + 'px';
    _sprite.style.top  = Math.round(y) + 'px';
    _sprite.style.transform = 'translate(-50%, -50%)' +
      (opts.scale && opts.scale !== 1 ? ' scale(' + opts.scale + ')' : '');
    _sprite.style.opacity = (opts.opacity === undefined) ? '' : String(opts.opacity);
    _sprite.classList.toggle('flourish-dim', !!opts.dim);
  }

  /* fadeTail(t, from) — 1 until `from`, then linear fade to 0 at t=1. */
  function fadeTail(t, from) {
    if (t <= from) return 1;
    return Math.max(0, 1 - (t - from) / (1 - from));
  }

  /* ── The eleven sketches ──────────────────────────────────────── */

  var DEFS = {

    /* cat — walks left→right along the bottom, legs alternating. */
    cat: { dur: 3200, frame: function (t, ms, w, h) {
      setSprite(CAT[Math.floor(ms / 160) % 2], w * (-0.08 + 1.16 * t), h * 0.86);
    } },

    /* dog — bounds across the bottom, tail wagging frame to frame. */
    dog: { dur: 3000, frame: function (t, ms, w, h) {
      var bounce = Math.abs(Math.sin(t * Math.PI * 5)) * h * 0.04;
      setSprite(DOG[Math.floor(ms / 140) % 2], w * (-0.08 + 1.16 * t), h * 0.86 - bounce);
    } },

    /* sun — rises out of the bottom-right corner, small arc, sets. */
    sun: { dur: 3000, frame: function (t, ms, w, h) {
      var arc = Math.sin(t * Math.PI);
      setSprite(SUN, w * (0.93 - 0.18 * arc), h * (0.99 - 0.30 * arc));
    } },

    /* moon — crescent drifts up top-center, two dots twinkling. */
    moon: { dur: 3000, frame: function (t, ms, w, h) {
      setSprite(MOON[Math.floor(ms / 420) % 2], w * 0.5, h * (0.26 - 0.14 * t),
        { dim: true, opacity: fadeTail(t, 0.8) });
    } },

    /* tree — grows from a sprout bottom-center, then fades away. */
    tree: { dur: 3000, frame: function (t, ms, w, h) {
      var stage = t < 0.18 ? 0 : t < 0.4 ? 1 : t < 0.62 ? 2 : 3;
      setSprite(TREE[stage], w * 0.5, h * 0.86, { opacity: fadeTail(t, 0.75) });
    } },

    /* star — a twinkle burst top-center: grows, flares, shrinks. */
    star: { dur: 2200, frame: function (t, ms, w, h) {
      var phase = Math.min(STAR.length - 1, Math.floor(t * STAR.length));
      setSprite(STAR[phase], w * 0.5, h * 0.16);
    } },

    /* rain — a brief column of falling drops, top-center. */
    rain: { dur: 2600, frame: function (t, ms, w, h) {
      var shift = Math.floor(ms / 130);
      var lines = [];
      for (var i = 0; i < RAIN.length; i++) {
        lines.push(RAIN[(i + RAIN.length - (shift % RAIN.length)) % RAIN.length]);
      }
      setSprite(lines.join('\n'), w * 0.5, h * 0.22,
        { dim: true, opacity: fadeTail(t, 0.7) });
    } },

    /* fish — swims across the lower third, bubbles drifting above. */
    fish: { dur: 3200, frame: function (t, ms, w, h) {
      setSprite(FISH[Math.floor(ms / 300) % 2], w * (-0.08 + 1.16 * t), h * 0.68);
    } },

    /* bird — flies across the top, wings alternating v / ^. */
    bird: { dur: 2600, frame: function (t, ms, w, h) {
      var glide = Math.sin(t * Math.PI * 3) * h * 0.02;
      setSprite(BIRD[Math.floor(ms / 180) % 2], w * (-0.06 + 1.12 * t), h * 0.1 + glide);
    } },

    /* mom — a small heart pulses beside the input line. */
    mom: { dur: 2600, anchor: true, frame: function (t, ms, w, h, a) {
      var beat = 1 + 0.3 * Math.max(0, Math.sin(2 * Math.PI * (ms % 600) / 600));
      setSprite(HEART, a.anchorX, a.anchorY,
        { scale: beat, opacity: fadeTail(t, 0.8) });
    } },

    /* dad — same heart, a double-thump rhythm (ba-dum … ba-dum). */
    dad: { dur: 2600, anchor: true, frame: function (t, ms, w, h, a) {
      var p = ms % 900;
      var beat = (p < 140 || (p > 280 && p < 420)) ? 1.35 : 1;
      setSprite(HEART, a.anchorX, a.anchorY,
        { scale: beat, opacity: fadeTail(t, 0.8) });
    } },

  };

  /* ── Engine ───────────────────────────────────────────────────── */

  function stop() {
    if (_raf) { cancelAnimationFrame(_raf); _raf = 0; }
    _active = null;
    if (_sprite) {
      _sprite.hidden = true;
      _sprite.style.opacity = '';
    }
  }

  function step(now) {
    _raf = 0;
    if (!_active) return;
    var ms = now - _active.start;
    var t  = ms / _active.def.dur;
    if (t >= 1) { stop(); return; }
    _active.def.frame(t, ms, window.innerWidth, window.innerHeight, _active);
    _raf = requestAnimationFrame(step);
  }

  function has(word) {
    return Object.prototype.hasOwnProperty.call(DEFS, word);
  }

  function play(word) {
    var def = DEFS[word];
    if (!def || !_sprite) return;   /* no-op for non-decorated words */
    stop();                          /* one flourish at a time */

    _active = { def: def, start: performance.now(), anchorX: 0, anchorY: 0 };

    if (def.anchor) {
      /* "Beside the input line": just right of the blinking cursor. */
      var cursor = document.getElementById('hub-cursor');
      if (cursor) {
        var r = cursor.getBoundingClientRect();
        _active.anchorX = r.right + 48;
        _active.anchorY = r.top + r.height / 2;
      } else {
        _active.anchorX = window.innerWidth * 0.5;
        _active.anchorY = window.innerHeight * 0.88;
      }
    }

    _sprite.hidden = false;
    _raf = requestAnimationFrame(step);
  }

  /* ── Register ─────────────────────────────────────────────────── */

  window.Glyphs.register('flourish', {
    init: function () {
      _layer = document.getElementById('flourish-layer');
      if (_layer) {
        _sprite = document.createElement('pre');
        _sprite.className = 'flourish-sprite';
        _sprite.hidden = true;
        _layer.appendChild(_sprite);
      }

      window.Glyphs.flourish = {
        play: play,
        has: has,
      };
    },
  });

}());
