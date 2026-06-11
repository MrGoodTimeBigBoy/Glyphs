'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('GlyphsHost', Object.freeze({
  platform: process.platform,

  // Phase 3: hub history persistence. Both invoke handlers in main.js
  // that never throw — load resolves [] and save resolves { ok: false }
  // on any failure, so the renderer needs no error handling beyond
  // ignoring the result.
  loadHistory: () => ipcRenderer.invoke('glyphs:history-load'),
  saveHistory: (entries) => ipcRenderer.invoke('glyphs:history-save', entries),

  // G2P: grapheme-to-phoneme. Returns { ok: true, phonemes, tier } or
  // { ok: false }. Never throws. Input sanitisation happens in main.js.
  g2p: (word) => ipcRenderer.invoke('glyphs:g2p', word),
}));
