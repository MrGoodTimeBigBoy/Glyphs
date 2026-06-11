'use strict';

// g2p/test_g2p.js — run via `node g2p/test_g2p.js` or `npm run test-g2p`.
// Tests the three-tier G2P pipeline independently and end-to-end.
// Exits non-zero if any test fails.

const { g2p, validatePhonemes, VALID_SYMBOLS } = require('./index');

let passed = 0;
let failed = 0;

function ok(label, cond) {
  if (cond) {
    console.log('PASS  ' + label);
    passed++;
  } else {
    console.log('FAIL  ' + label);
    failed++;
  }
}

async function main() {
  console.log('──────────────────────────────────────────────');
  console.log('G2P test suite');
  console.log('──────────────────────────────────────────────');

  // ── Validation helper tests ─────────────────────────────────────────────

  ok('validatePhonemes rejects empty array', !validatePhonemes([]));
  ok('validatePhonemes rejects null', !validatePhonemes(null));
  ok('validatePhonemes rejects garbage symbol', !validatePhonemes(['XX', 'AE', 'T']));
  ok('validatePhonemes rejects lowercase', !validatePhonemes(['k', 'ae', 't']));
  ok('validatePhonemes accepts [K AE T]', validatePhonemes(['K', 'AE', 'T']));
  ok('validatePhonemes accepts all 39 symbols', validatePhonemes([...VALID_SYMBOLS]));

  // ── CMU tier ────────────────────────────────────────────────────────────

  console.log('\n── Tier 1: CMU dict ──');

  // Force CMU tier.
  const origTier = process.env.GLYPHS_PHONICS_TIER;
  process.env.GLYPHS_PHONICS_TIER = 'cmu';
  process.env.GLYPHS_LOG_TIER = '1';

  const cat = await g2p('cat');
  ok('cmu: cat resolves', cat !== null && cat.tier === 'cmu');
  ok('cmu: cat → K AE T', cat && cat.phonemes.join(' ') === 'K AE T');

  const shop = await g2p('shop');
  ok('cmu: shop resolves', shop !== null && shop.tier === 'cmu');
  ok('cmu: shop → SH AA P', shop && shop.phonemes.join(' ') === 'SH AA P');

  const the = await g2p('the');
  ok('cmu: "the" resolves', the !== null && the.tier === 'cmu');
  ok('cmu: "the" phonemes are valid', the && validatePhonemes(the.phonemes));

  // CMU should miss made-up words.
  const made_up_cmu = await g2p('blorf');
  ok('cmu: made-up word "blorf" returns null (miss is expected)', made_up_cmu === null);

  // ── eSpeak tier ─────────────────────────────────────────────────────────

  console.log('\n── Tier 2: eSpeak NG ──');
  process.env.GLYPHS_PHONICS_TIER = 'espeak';

  const cat_es = await g2p('cat');
  ok('espeak: cat resolves', cat_es !== null && cat_es.tier === 'espeak');
  ok('espeak: cat phonemes are valid', cat_es && validatePhonemes(cat_es.phonemes));
  if (cat_es) console.log('       cat → ' + cat_es.phonemes.join(' '));

  const shop_es = await g2p('shop');
  ok('espeak: shop resolves', shop_es !== null && shop_es.tier === 'espeak');
  ok('espeak: shop phonemes are valid', shop_es && validatePhonemes(shop_es.phonemes));
  if (shop_es) console.log('       shop → ' + shop_es.phonemes.join(' '));

  const blorf_es = await g2p('blorf');
  ok('espeak: made-up word "blorf" resolves', blorf_es !== null && blorf_es.tier === 'espeak');
  ok('espeak: blorf phonemes are valid', blorf_es && validatePhonemes(blorf_es.phonemes));
  if (blorf_es) console.log('       blorf → ' + blorf_es.phonemes.join(' '));

  // ── CMU–eSpeak agreement ────────────────────────────────────────────────

  console.log('\n── CMU–eSpeak agreement on 30 common words ──');
  const THIRTY = [
    'cat', 'bat', 'hat', 'rat', 'mat',
    'dog', 'fish', 'bird', 'sun', 'run',
    'shop', 'ship', 'she', 'the', 'chair',
    'cheese', 'phone', 'night', 'beautiful', 'chocolate',
    'finger', 'sugar', 'vision', 'jump', 'play',
    'tree', 'boat', 'rain', 'coin', 'boy',
  ];
  let exact = 0;
  let total = 0;
  for (const w of THIRTY) {
    process.env.GLYPHS_PHONICS_TIER = 'cmu';
    const cmuResult = await g2p(w);
    process.env.GLYPHS_PHONICS_TIER = 'espeak';
    const esResult = await g2p(w);
    if (!cmuResult || !esResult) {
      console.log('  skip ' + w + ' (one tier missed)');
      continue;
    }
    total++;
    const match = cmuResult.phonemes.join(' ') === esResult.phonemes.join(' ');
    if (match) exact++;
    console.log('  ' + (match ? '✓' : '~') + ' ' + w +
      '\n    cmu:    ' + cmuResult.phonemes.join(' ') +
      '\n    espeak: ' + esResult.phonemes.join(' '));
  }
  console.log('\nExact agreement: ' + exact + '/' + total + ' (' +
    Math.round(100 * exact / total) + '%)');

  // ── LLM / fm tier ───────────────────────────────────────────────────────

  console.log('\n── Tier 3: fm (Apple Foundation Models) ──');
  process.env.GLYPHS_PHONICS_TIER = 'llm';

  // "blorf" is a made-up word that fm handles reliably (tested: 3/3 consistent).
  const t0_blorf = Date.now();
  const blorf_fm = await g2p('blorf');
  const ms_blorf = Date.now() - t0_blorf;
  ok('llm: "blorf" resolves', blorf_fm !== null && blorf_fm.tier === 'llm');
  ok('llm: blorf phonemes are valid', blorf_fm && validatePhonemes(blorf_fm.phonemes));
  console.log('  blorf → ' + (blorf_fm ? blorf_fm.phonemes.join(' ') : 'null') +
    ' (' + ms_blorf + ' ms)');

  // "finger" is a known word that fm handles correctly.
  const t0_finger = Date.now();
  const finger_fm = await g2p('finger');
  const ms_finger = Date.now() - t0_finger;
  ok('llm: "finger" resolves', finger_fm !== null && finger_fm.tier === 'llm');
  ok('llm: finger phonemes are valid', finger_fm && validatePhonemes(finger_fm.phonemes));
  console.log('  finger → ' + (finger_fm ? finger_fm.phonemes.join(' ') : 'null') +
    ' (' + ms_finger + ' ms)');

  // ── Tiered path ─────────────────────────────────────────────────────────

  console.log('\n── Tiered path (CMU → eSpeak → fm) ──');
  process.env.GLYPHS_PHONICS_TIER = 'tiered';

  const cat_tiered = await g2p('cat');
  ok('tiered: "cat" resolves via CMU', cat_tiered && cat_tiered.tier === 'cmu');
  console.log('  cat → ' + (cat_tiered ? cat_tiered.phonemes.join(' ') + ' [' + cat_tiered.tier + ']' : 'null'));

  // "blorf" is CMU-miss → eSpeak handles it.
  const blorf_tiered = await g2p('blorf');
  ok('tiered: made-up "blorf" resolves (espeak or llm)',
    blorf_tiered !== null && (blorf_tiered.tier === 'espeak' || blorf_tiered.tier === 'llm'));
  console.log('  blorf → ' + (blorf_tiered ? blorf_tiered.phonemes.join(' ') + ' [' + blorf_tiered.tier + ']' : 'null'));

  // "snizzle" is also CMU-miss → eSpeak tier.
  const snizzle_tiered = await g2p('snizzle');
  ok('tiered: made-up "snizzle" resolves (espeak or llm)',
    snizzle_tiered !== null && (snizzle_tiered.tier === 'espeak' || snizzle_tiered.tier === 'llm'));
  console.log('  snizzle → ' + (snizzle_tiered ? snizzle_tiered.phonemes.join(' ') + ' [' + snizzle_tiered.tier + ']' : 'null'));

  // ── Input sanitisation (IPC-level logic mirrored here) ───────────────────

  console.log('\n── Validation / sanitisation ──');

  // The g2p() function itself accepts clean lowercased words.
  // IPC-level rejection of >64 chars / non-alpha is tested conceptually here.
  const too_long = await g2p('a'.repeat(65));
  // g2p() itself doesn't enforce length — that's the IPC handler.
  // Instead test that garbage phoneme output gets caught by validatePhonemes.
  ok('validatePhonemes rejects single invalid sym', !validatePhonemes(['EE']));
  ok('validatePhonemes rejects mixed valid/invalid', !validatePhonemes(['K', 'AE', 'EE']));
  ok('validatePhonemes accepts ZH NG etc', validatePhonemes(['ZH', 'NG', 'OY', 'AW', 'DH']));

  // Restore env.
  if (origTier === undefined) delete process.env.GLYPHS_PHONICS_TIER;
  else process.env.GLYPHS_PHONICS_TIER = origTier;

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log('\n──────────────────────────────────────────────');
  console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
  console.log('──────────────────────────────────────────────');

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
