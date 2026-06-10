/* window.Glyphs — root namespace.
   Defines register() and boot(); registers nothing itself. */

(function () {
  'use strict';

  if (window.Glyphs) {
    console.warn('Glyphs: namespace already defined — namespace.js loaded twice?');
    return;
  }

  var _modules = [];   // [{ name, module }] in registration order
  var _booted  = false;

  window.Glyphs = {

    register: function (name, module) {
      for (var i = 0; i < _modules.length; i++) {
        if (_modules[i].name === name) {
          console.warn('Glyphs.register: duplicate name "' + name + '" — ignoring');
          return;
        }
      }
      _modules.push({ name: name, module: module });
    },

    boot: function () {
      if (_booted) {
        console.warn('Glyphs.boot: already booted — ignoring');
        return;
      }
      _booted = true;
      for (var i = 0; i < _modules.length; i++) {
        _modules[i].module.init();
      }
    },

  };
}());
