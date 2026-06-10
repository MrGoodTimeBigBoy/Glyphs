/* DOM-level containment. OS-level containment is the main process's job. */

window.Glyphs.register('containment', {
  init: function () {
    // Right-click does nothing.
    document.addEventListener('contextmenu', function (e) {
      e.preventDefault();
    });

    // No file-drop.
    window.addEventListener('dragover', function (e) {
      e.preventDefault();
    });
    window.addEventListener('drop', function (e) {
      e.preventDefault();
    });

    // Nothing in-page is draggable.
    document.addEventListener('dragstart', function (e) {
      e.preventDefault();
    });
  },
});
