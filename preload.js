'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('GlyphsHost', Object.freeze({
  platform: process.platform,
}));
