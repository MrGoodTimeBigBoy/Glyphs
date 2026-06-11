# g2p — Grapheme-to-Phoneme assets

## cmudict.dict

The **CMU Pronouncing Dictionary** (`cmudict.dict`), downloaded from:

  https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict

**License:** BSD (CMUdict, from the CMU Sphinx project — https://github.com/cmusphinx/cmudict).

**Format:** one entry per line:

```
word PH1 PH2 PH3
```

Phonemes are ARPABET symbols; vowels carry a stress digit (0 = no stress,
1 = primary, 2 = secondary).  The G2P consumer (`tools/tts/test_phonemes.py`
and the future G2P layer) strips stress digits before mapping phonemes to
clip filenames.

**Why committed:** the app must work fully offline. The dictionary is
~3.5 MB of plain text and is committed to the repository so that G2P
lookups work on any machine without a network connection.
