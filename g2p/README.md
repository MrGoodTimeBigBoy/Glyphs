# g2p — the grapheme-to-phoneme pipeline

Resolves any typed word to a sequence of ARPABET phonemes for speak mode's
unknown-word sound-out. Lives in the **main process**; the renderer reaches
it through `window.GlyphsHost.g2p(word)` → `{ ok, phonemes, tier }` over the
`glyphs:g2p` IPC channel.

## index.js — three tiers, in order

| Tier | Source | Latency | Used for |
|------|--------|---------|----------|
| `cmu` | `cmudict.dict` (bundled, lazy-parsed Map) | instant | the ~135k dictionary words |
| `espeak` | `espeak-ng` npm package (WASM, IPA output mapped to ARPABET) | ~ms | anything CMU misses; ~90% CMU agreement on common words |
| `llm` | `/usr/bin/fm` (Apple Foundation Models CLI, on-device) | ~10 s | last resort; the hub's "hmm" plus a beat of thinking silence covers it |

Every tier's output is validated against the 39-symbol ARPABET set
(stress digits stripped); invalid or failed output falls through to the
next tier. The `fm` tier is constrained by a JSON schema
(`phonemes.schema.json` is the canonical copy; a runtime copy with the
same enum is written to the OS temp dir because fm requires an `x-order`
field and the packaged app dir may be read-only).

## Developer affordances

```sh
GLYPHS_PHONICS_TIER=cmu|espeak|llm   # force exactly one tier (default: tiered)
GLYPHS_LOG_TIER=1                    # log one line per resolution + fall-throughs
npm run test-g2p                     # the full suite (exercises all three tiers live)
```

## cmudict.dict

The **CMU Pronouncing Dictionary**, downloaded from:

  https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict

**License:** BSD (CMUdict, from the CMU Sphinx project —
https://github.com/cmusphinx/cmudict).

**Format:** one entry per line:

```
word PH1 PH2 PH3
```

Phonemes are ARPABET symbols; vowels carry a stress digit (0 = no stress,
1 = primary, 2 = secondary). Consumers (`index.js`,
`tools/tts/test_phonemes.py`) strip stress digits before mapping phonemes
to clip filenames.

**Why committed:** the app must work fully offline. The dictionary is
~3.5 MB of plain text and is committed to the repository so that G2P
lookups work on any machine without a network connection.
