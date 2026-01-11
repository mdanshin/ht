# Hover Translate EN→RU (StarDict offline + optional online fallback)

## No conversion required — use your StarDict package as-is
Your folder contains:
- eng-rus.ifo
- eng-rus.idx.gz
- eng-rus.dict.dz

This add-on supports exactly that StarDict layout: `.ifo` + `.idx.gz` + `.dict.dz`.
StarDict format explicitly supports compressed `.idx.gz` and dictzip `.dict.dz` (gzip-compatible). 

## How to bundle the dictionary (developer step)
Copy your 3 files into the add-on folder `dict/` and rename to:
- dict/eng-rus.ifo
- dict/eng-rus.idx.gz
- dict/eng-rus.dict.dz

If you prefer to keep original names, change `BASE` in `background.js`.

Also copy the dictionary license file (e.g., COPYING) into the add-on and mention it in your listing.

## Development install
Firefox → about:debugging#/runtime/this-firefox → Load Temporary Add-on… → manifest.json

## UI
- Tooltip styled as "liquid glass": translucent surface, blur (when supported), highlights.

## Options
- Tooltip trigger: Hover / Alt+Hover / Double-click
- Online translation (MyMemory): optional permission, used for (1) missing words, and (2) selected phrases (2+ words)
- Self-test verifies dictionary load

## Pronunciation (audio)
The tooltip includes a small speaker button.
When you click it, the add-on tries to fetch a pronunciation audio URL from the free DictionaryAPI service
and plays it. If no audio is available, it falls back to the browser's built-in TTS (speechSynthesis).

Privacy note: the word is sent to the pronunciation service only when you click the speaker button.

## RAM note
The `.dict.dz` is decompressed into memory once per browser session for fast random access.
Large dictionaries can use noticeable RAM.
