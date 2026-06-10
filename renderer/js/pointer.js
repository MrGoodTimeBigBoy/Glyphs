/* Mouse pointer auto-hide: vanishes 2 s after the last movement.
   Timer starts at init, so the pointer hides even if the mouse is never moved. */

window.Glyphs.register('pointer', {
  init: function () {
    var IDLE_MS = 2000;
    var timer   = null;

    function hide() {
      document.body.classList.add('pointer-hidden');
    }

    function onMove() {
      document.body.classList.remove('pointer-hidden');
      clearTimeout(timer);
      timer = setTimeout(hide, IDLE_MS);
    }

    window.addEventListener('mousemove', onMove);

    // Start the idle clock immediately.
    timer = setTimeout(hide, IDLE_MS);
  },
});
