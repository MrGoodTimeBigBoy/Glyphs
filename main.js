'use strict';

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { createWindow } = require('./window');
const { installAppLevel, attachToWindow } = require('./containment');
const { g2p } = require('./g2p');

const isDev = process.argv.includes('--dev');
const isSmoke = process.argv.includes('--smoke');
// Phase 2: --audio-test loads the audio validation harness instead of the
// Phase 1 shell. It does not touch the cage; plain typing already passes through.
const isAudioTest = process.argv.includes('--audio-test');
const page = isAudioTest ? 'test-audio.html' : 'index.html';

// Catch unhandled exceptions: log and exit non-zero so CI notices.
process.on('uncaughtException', (err) => {
  process.stderr.write((err && err.stack ? err.stack : String(err)) + '\n');
  app.exit(1);
});

// Install app-level containment before the app is ready so that the
// web-contents-created listener is in place for the very first webContents.
installAppLevel({ isDev });

// ── Phase 3: hub history persistence ────────────────────────────────────────
// JSON file in userData; capped; atomic write (tmp + rename). Neither handler
// ever throws to the renderer: load resolves [] and save resolves
// { ok: false } on any failure.

const HISTORY_CAP = 500;

function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}

// Keep only well-formed { word, type, ts } entries, newest-last, capped.
function sanitizeHistory(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  for (const e of entries) {
    if (!e || typeof e.word !== 'string' || typeof e.type !== 'string') continue;
    out.push({ word: e.word.slice(0, 64), type: e.type, ts: Number(e.ts) || 0 });
  }
  return out.slice(-HISTORY_CAP);
}

ipcMain.handle('glyphs:history-load', () => {
  try {
    return sanitizeHistory(JSON.parse(fs.readFileSync(historyPath(), 'utf8')));
  } catch (err) {
    return []; // missing file, bad JSON, unreadable disk — all the same: empty
  }
});

// ── G2P: grapheme-to-phoneme ─────────────────────────────────────────────────
// Sanitise input in the main process; never throw to the renderer.
// Returns { ok: true, phonemes, tier } or { ok: false }.

// Only letters a–z and the apostrophe (contractions) are accepted.
const G2P_ALLOWED = /^[a-z']+$/;

ipcMain.handle('glyphs:g2p', async (event, word) => {
  try {
    if (typeof word !== 'string') return { ok: false };
    const w = word.toLowerCase().trim();
    if (!w || w.length > 64) return { ok: false };
    if (!G2P_ALLOWED.test(w)) return { ok: false };
    const result = await g2p(w);
    if (!result) return { ok: false };
    return { ok: true, phonemes: result.phonemes, tier: result.tier };
  } catch (err) {
    return { ok: false };
  }
});

ipcMain.handle('glyphs:history-save', (event, entries) => {
  try {
    const file = historyPath();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sanitizeHistory(entries)));
    fs.renameSync(tmp, file); // atomic on the same filesystem
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
});

// ── Mode persistence (speak / spell) ────────────────────────────────────────
// JSON file in userData; atomic write (tmp + rename). Neither handler ever
// throws to the renderer: load resolves 'speak' and save resolves
// { ok: false } on any failure.

function modePath() {
  return path.join(app.getPath('userData'), 'mode.json');
}

function sanitizeMode(m) {
  return (m === 'speak' || m === 'spell') ? m : 'speak';
}

ipcMain.handle('glyphs:mode-load', () => {
  try {
    const raw = JSON.parse(fs.readFileSync(modePath(), 'utf8'));
    return sanitizeMode(raw && raw.mode);
  } catch (err) {
    return 'speak'; // missing file, bad JSON, unreadable disk — default
  }
});

ipcMain.handle('glyphs:mode-save', (event, mode) => {
  try {
    const safeMode = sanitizeMode(mode);
    const file = modePath();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ mode: safeMode }));
    fs.renameSync(tmp, file); // atomic on the same filesystem
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
});

// Single-window kiosk: quit on all platforms when the window is closed.
// No macOS "linger with no windows" behaviour.
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  const win = createWindow({ isDev, page });
  attachToWindow(win, { isDev });

  if (isSmoke) {
    // Smoke mode: used for headless CI verification only.
    // Give the renderer 2 s to settle after load, then exit cleanly.
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => app.quit(), 2000);
    });

    win.webContents.once('did-fail-load', () => {
      app.exit(1);
    });
  }
});
