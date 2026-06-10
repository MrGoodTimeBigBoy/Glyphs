/* Boot: call Glyphs.boot() once the DOM is ready.
   Scripts sit at end of body, so readyState is typically 'interactive' by
   the time this runs — but both paths are handled to be safe. */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () {
    window.Glyphs.boot();
  });
} else {
  window.Glyphs.boot();
}
