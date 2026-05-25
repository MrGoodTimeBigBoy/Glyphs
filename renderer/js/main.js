(function () {
  "use strict";

  function boot() {
    window.Glyphs.containment.init();
    window.Glyphs.cursorIdle.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
