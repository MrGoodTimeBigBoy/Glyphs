(function () {
  "use strict";

  function boot() {
    // Guard each module independently: if one script fails to load, the
    // other still initializes rather than the whole cage going dark.
    const g = window.Glyphs || {};
    if (g.containment) g.containment.init();
    if (g.cursorIdle) g.cursorIdle.init();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
