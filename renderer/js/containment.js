(function () {
  "use strict";

  function init() {
    const block = (event) => event.preventDefault();

    document.addEventListener("contextmenu", block);
    document.addEventListener("dragstart", block);
    document.addEventListener("dragover", block);
    document.addEventListener("drop", block);
    document.addEventListener("selectstart", block);
  }

  window.Glyphs = window.Glyphs || {};
  window.Glyphs.containment = { init };
})();
