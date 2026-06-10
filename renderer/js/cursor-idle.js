(function () {
  "use strict";

  const IDLE_MS = 2000;

  function init() {
    let timer = null;

    const hide = () => document.body.classList.add("cursor-hidden");
    const show = () => {
      document.body.classList.remove("cursor-hidden");
      window.clearTimeout(timer);
      timer = window.setTimeout(hide, IDLE_MS);
    };

    window.addEventListener("mousemove", show, { passive: true });
    window.addEventListener("mousedown", show, { passive: true });

    timer = window.setTimeout(hide, IDLE_MS);
  }

  window.Glyphs = window.Glyphs || {};
  window.Glyphs.cursorIdle = { init };
})();
