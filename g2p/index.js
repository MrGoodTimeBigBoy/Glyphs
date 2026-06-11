'use strict';

// g2p/index.js — three-tier grapheme-to-phoneme pipeline.
// Plain CommonJS; no Electron imports; safe to require from both the
// Electron main process and bare node.
//
// Tiers (in order):
//   1. CMU Pronouncing Dictionary  — instant, ~100 ms one-time parse
//   2. eSpeak NG WASM              — fast, IPA→ARPABET via static table
//   3. fm CLI (Apple Foundation Models) — LLM fallback, ~10 s
//
// Environment variables:
//   GLYPHS_PHONICS_TIER  tiered | cmu | espeak | llm  (default: tiered)
//   GLYPHS_LOG_TIER=1    log one line per resolution + failures

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ── 39 valid ARPABET symbols ────────────────────────────────────────────────

const VALID_SYMBOLS = new Set([
  'AA','AE','AH','AO','AW','AY',
  'B','CH','D','DH',
  'EH','ER','EY',
  'F','G','HH',
  'IH','IY','JH',
  'K','L','M','N','NG',
  'OW','OY','P','R','S','SH',
  'T','TH','UH','UW',
  'V','W','Y','Z','ZH',
]);

// Stress digits and length mark appended by CMU dict (e.g. AH0, IY1, ː).
// Strip them before validation.
function stripStress(sym) {
  return sym.replace(/[0-9]/g, '').toUpperCase();
}

function validatePhonemes(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  for (const sym of arr) {
    if (!VALID_SYMBOLS.has(sym)) return false;
  }
  return true;
}

// ── Logging helper ──────────────────────────────────────────────────────────

const LOG = process.env.GLYPHS_LOG_TIER === '1';

function log(msg) {
  if (LOG) process.stderr.write('[g2p] ' + msg + '\n');
}

// ── Tier 1: CMU dict ────────────────────────────────────────────────────────

const DICT_PATH = path.join(__dirname, 'cmudict.dict');

let _cmuMap = null; // Map<string, string[]>

function loadCmuDict() {
  if (_cmuMap) return _cmuMap;
  const raw = fs.readFileSync(DICT_PATH, 'utf8');
  const map = new Map();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 2) continue;
    const key = tokens[0];
    // Skip variant lines like "word(2)", "word(3)", etc.
    if (/\(\d+\)$/.test(key)) continue;
    const phonemes = [];
    for (let i = 1; i < tokens.length; i++) {
      const sym = stripStress(tokens[i]);
      if (sym) phonemes.push(sym);
    }
    if (phonemes.length > 0) {
      map.set(key.toLowerCase(), phonemes);
    }
  }
  _cmuMap = map;
  return map;
}

function tierCmu(word) {
  const map = loadCmuDict();
  const entry = map.get(word.toLowerCase());
  if (!entry) return null;
  if (!validatePhonemes(entry)) return null;
  return entry;
}

// ── Tier 2: eSpeak NG WASM ──────────────────────────────────────────────────
// Loaded once on first use via dynamic import (it's an ES module).

let _eSpeakPromise = null;
let _eSpeakUnavailable = false;

// IPA → ARPABET mapping table.
// Rules are applied as ordered string replacements on the IPA string after
// stripping stress marks (ˈˌ), length mark (ː), and the Unicode zero-width
// joiner (U+200D) used as a tie for affricates and diphthongs.
//
// The zero-width joiner appears between the two parts of a tied sequence
// (e.g. t‍ʃ, d‍ʒ, a‍ɪ, o‍ʊ) — we strip it so sequences become simple
// two-char spans that our character-by-character mapper handles.
//
// Processing order matters: multi-char sequences must come before their
// component chars.

// Ordered replacement pairs: [ipaChars, arpabet].
// Applied longest-first within the mapper; the table is ordered accordingly.
const IPA_TABLE = [
  // ── Affricates (tie-joined, ZWJ stripped) ──────────────────────────
  ['tʃ', 'CH'],
  ['dʒ', 'JH'],

  // ── Diphthongs (tie-joined) ────────────────────────────────────────
  ['eɪ', 'EY'],
  ['aɪ', 'AY'],
  ['ɔɪ', 'OY'],
  ['aʊ', 'AW'],
  ['oʊ', 'OW'],

  // ── Vowels ─────────────────────────────────────────────────────────
  ['ɑː', 'AA'],   // long a, e.g. father, dog (en-us AA)
  ['ɑ',  'AA'],
  ['æ',  'AE'],   // trap
  ['ʌ',  'AH'],   // strut
  ['ə',  'AH'],   // schwa  (maps to AH, unstressed)
  ['ɔː', 'AO'],   // thought
  ['ɔ',  'AO'],
  ['ɛ',  'EH'],   // dress
  ['e',  'EH'],   // en-us eSpeak sometimes emits plain e in diphthongs already handled above
  ['ɚ',  'ER'],   // rhotacized schwa (butter, water)
  ['ɜː', 'ER'],   // nurse (bird, her)
  ['ɜ',  'ER'],
  ['ɪ',  'IH'],   // kit
  ['iː', 'IY'],   // fleece
  ['i',  'IY'],   // free variant
  ['o',  'OW'],   // en-us eSpeak plain o (e.g. go before diphthong handled above)
  ['ʊ',  'UH'],   // foot
  ['uː', 'UW'],   // goose
  ['u',  'UW'],

  // ── Consonants ──────────────────────────────────────────────────────
  ['b',  'B'],
  ['d',  'D'],
  ['ð',  'DH'],
  ['f',  'F'],
  ['ɡ',  'G'],   // voiced velar stop (U+0261, IPA gamma — distinct from ASCII g)
  ['g',  'G'],   // ASCII g fallback
  ['h',  'HH'],
  ['k',  'K'],
  ['l',  'L'],
  ['m',  'M'],
  ['n',  'N'],
  ['ŋ',  'NG'],
  ['p',  'P'],
  ['ɹ',  'R'],   // turned r (en-us)
  ['r',  'R'],   // plain r fallback
  ['s',  'S'],
  ['ʃ',  'SH'],
  ['t',  'T'],
  ['θ',  'TH'],
  ['v',  'V'],
  ['w',  'W'],
  ['j',  'Y'],   // palatal approximant
  ['z',  'Z'],
  ['ʒ',  'ZH'],

  // ── eSpeak-specific extras ──────────────────────────────────────────
  ['ɾ',  'T'],   // American English flap (butter, water) — closer to T than D
  ['ʔ',  ''],    // glottal stop (button) — drop; syllabic consonant follows
  // syllabic consonants (with combining ring below ̩):
  // n̩ (U+006E + U+0329) and l̩ — map to their plain counterparts
  ['n̩', 'N'],
  ['l̩', 'L'],
  ['m̩', 'M'],
];

// Pre-build a regex that matches any IPA sequence we need to replace.
// We need to try longer strings first; the table is already ordered that way,
// so we process char-by-char from left to right using the table.
function ipaToArpabet(ipaRaw) {
  // Step 1: strip stress, length, and ZWJ tie characters.
  // U+02C8 = primary stress ˈ, U+02CC = secondary stress ˌ
  // U+02D0 = length mark ː
  // U+200D = zero-width joiner (affricate/diphthong tie)
  let ipa = ipaRaw
    .replace(/[ˈˌː‍]/g, '')
    .trim();

  const result = [];
  let i = 0;
  outer: while (i < ipa.length) {
    // Try each table entry (longest first — table is ordered).
    for (const [seq, arp] of IPA_TABLE) {
      if (ipa.startsWith(seq, i)) {
        if (arp) result.push(arp);
        i += seq.length;
        continue outer;
      }
    }
    // Unrecognised character — return null to signal tier failure.
    log('espeak: unmapped IPA char ' + JSON.stringify(ipa[i]) +
        ' (U+' + ipa.codePointAt(i).toString(16).toUpperCase() + ')');
    return null;
  }
  return result;
}

async function loadEspeak() {
  if (_eSpeakUnavailable) return null;
  if (!_eSpeakPromise) {
    _eSpeakPromise = (async () => {
      try {
        // espeak-ng is an ES module — use dynamic import.
        const mod = await import('espeak-ng');
        return mod.default;
      } catch (e) {
        _eSpeakUnavailable = true;
        log('espeak: unavailable — ' + e.message);
        return null;
      }
    })();
  }
  return _eSpeakPromise;
}

async function tierEspeak(word) {
  const ESpeakNg = await loadEspeak();
  if (!ESpeakNg) return null;
  try {
    const espeak = await ESpeakNg({
      arguments: [
        '--phonout', 'generated',
        '--sep= ',
        '-q',
        '--ipa=3',
        '-v', 'en-us',
        word,
      ],
    });
    const ipaRaw = espeak.FS.readFile('generated', { encoding: 'utf8' }).trim();
    if (!ipaRaw) return null;
    const phonemes = ipaToArpabet(ipaRaw);
    if (!phonemes) return null;
    if (!validatePhonemes(phonemes)) return null;
    return phonemes;
  } catch (e) {
    log('espeak: error — ' + e.message);
    return null;
  }
}

// ── Tier 3: fm CLI (Apple Foundation Models) ───────────────────────────────

const FM_BIN = '/usr/bin/fm';
const FM_SCHEMA = path.join(__dirname, 'phonemes.schema.json');
const FM_TIMEOUT_MS = 15000;

// The fm schema for phonemes uses string arrays (no enum constraint in the
// fm schema format); we validate against VALID_SYMBOLS after parsing.
// Prompt is kept terse but explicit — the on-device model is small and
// benefits from examples and a clear enumeration of valid symbols.
const FM_PROMPT_PREFIX =
  'You are a phonetician. Transcribe the English word into ARPABET phonemes. ' +
  'Use ONLY these 39 symbols (one per array element): ' +
  'AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG ' +
  'OW OY P R S SH T TH UH UW V W Y Z ZH. ' +
  'For invented words, apply English pronunciation rules. ' +
  'Each phoneme must be a separate array element. ' +
  'Example for "cat": ["K","AE","T"]. Example for "shop": ["SH","AO","P"]. ' +
  'Word: ';

// Build the fm schema that constrains output to a JSON object with a
// phonemes string array.  fm requires x-order in addition to the standard
// JSON Schema fields; without it fm rejects the file as "missing".  We use
// fm's own schema format (no enum; we validate against VALID_SYMBOLS after
// parsing) so that the --schema flag suppresses markdown fencing.
function buildFmSchema() {
  // Indent for readability; fm reads it as a file.
  return JSON.stringify({
    title: 'Phonemes',
    type: 'object',
    'x-order': ['phonemes'],
    required: ['phonemes'],
    additionalProperties: false,
    properties: {
      phonemes: { type: 'array', items: { type: 'string' } },
    },
  }, null, 2);
}

// Write the fm-compatible schema to a temp file (once) and reuse it.
let _fmSchemaPath = null;
function getFmSchemaPath() {
  if (_fmSchemaPath) return _fmSchemaPath;
  // Write next to the canonical phonemes.schema.json; ephemeral but stable.
  const p = path.join(__dirname, '_fm_schema_runtime.json');
  fs.writeFileSync(p, buildFmSchema());
  _fmSchemaPath = p;
  return p;
}

async function tierFm(word) {
  return new Promise((resolve) => {
    const schemaPath = getFmSchemaPath();
    const prompt = FM_PROMPT_PREFIX + word;
    const args = ['respond', '--no-stream', '--schema', schemaPath, prompt];

    execFile(FM_BIN, args, { timeout: FM_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        log('fm: error — ' + (err.message || err));
        return resolve(null);
      }
      const raw = (stdout || '').trim();
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        log('fm: invalid JSON — ' + JSON.stringify(raw.slice(0, 80)));
        return resolve(null);
      }
      if (!parsed || !Array.isArray(parsed.phonemes)) {
        log('fm: missing phonemes array');
        return resolve(null);
      }
      // Post-process: uppercase, split each element on whitespace (the small
      // on-device model occasionally packs multiple phonemes into one string,
      // e.g. [" TH EH"] → ["TH", "EH"]), and filter out empty strings.
      const phonemes = parsed.phonemes
        .flatMap((s) => String(s).toUpperCase().trim().split(/\s+/))
        .filter((s) => s.length > 0);
      if (!validatePhonemes(phonemes)) {
        log('fm: invalid symbols in output — ' + phonemes.join(' '));
        return resolve(null);
      }
      resolve(phonemes);
    });
  });
}

// ── Main exported function ──────────────────────────────────────────────────

/**
 * g2p(word) → Promise<{ phonemes: string[], tier: 'cmu'|'espeak'|'llm' } | null>
 *
 * Resolves to null if every applicable tier fails or the word is invalid.
 *
 * Tier selection is governed by the GLYPHS_PHONICS_TIER env var:
 *   tiered  — CMU → eSpeak → fm (default)
 *   cmu     — CMU only, no fallback
 *   espeak  — eSpeak only, no fallback
 *   llm     — fm only, no fallback
 */
async function g2p(word) {
  const mode = (process.env.GLYPHS_PHONICS_TIER || 'tiered').toLowerCase();

  async function tryTier(name, fn) {
    try {
      const phonemes = await fn(word);
      if (phonemes) {
        log('"' + word + '" → ' + name + ': ' + phonemes.join(' '));
        return { phonemes, tier: name === 'cmu' ? 'cmu' : name === 'espeak' ? 'espeak' : 'llm' };
      }
      log('"' + word + '" → ' + name + ': miss/fail, falling through');
    } catch (e) {
      log('"' + word + '" → ' + name + ': threw — ' + e.message);
    }
    return null;
  }

  if (mode === 'cmu') {
    return await tryTier('cmu', tierCmu);
  }
  if (mode === 'espeak') {
    return await tryTier('espeak', tierEspeak);
  }
  if (mode === 'llm') {
    return await tryTier('llm', tierFm);
  }

  // Default: tiered
  const r1 = await tryTier('cmu', tierCmu);
  if (r1) return r1;
  const r2 = await tryTier('espeak', tierEspeak);
  if (r2) return r2;
  return await tryTier('llm', tierFm);
}

module.exports = { g2p, validatePhonemes, VALID_SYMBOLS };
