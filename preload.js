const { contextBridge } = require('electron');

// The secure boundary. Phase 1 exposes only the platform string; later
// phases add narrow, named channels here rather than opening the bridge wide.
contextBridge.exposeInMainWorld('glyphs', {
  platform: process.platform,
});
