/* crt.js — Glyphs Phase 3 CRT atmosphere.
   One slow scanline sweep + a gentle phosphor flicker, per DESIGN
   ("the hub gently breathes — alive but not busy").

   This module only builds two pointer-events-none overlays and adds the
   .crt-on class to <body>; everything that moves is a CSS animation in
   styles.css. Zero per-frame JS.
*/

(function () {
  'use strict';

  window.Glyphs.register('crt', {
    init: function () {
      var scanline = document.createElement('div');
      scanline.className = 'crt-scanline';
      scanline.setAttribute('aria-hidden', 'true');

      var flicker = document.createElement('div');
      flicker.className = 'crt-flicker';
      flicker.setAttribute('aria-hidden', 'true');

      document.body.appendChild(flicker);
      document.body.appendChild(scanline);

      /* The animations in styles.css are gated on this class. */
      document.body.classList.add('crt-on');
    },
  });

}());
