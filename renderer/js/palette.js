/* palette.js — live palette access.
   Exposes window.Glyphs.palette.get(token) → current color string,
   read live from the body's computed custom properties so it always
   reflects the active mode without caching. */

(function () {
  'use strict';

  window.Glyphs.register('palette', {
    init: function () {
      window.Glyphs.palette = {
        get: function (token) {
          return getComputedStyle(document.body)
                   .getPropertyValue('--ph-' + token).trim();
        },
      };
    },
  });

}());
