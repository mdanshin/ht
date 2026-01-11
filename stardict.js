// StarDict loader for (ifo + idx/idx.gz + dict/dict.dz).
// Uses DecompressionStream('gzip') to inflate .gz and .dz (dictzip is gzip-compatible).
// StarDict notes: .idx may be gzipped; .dict may be dictzip (.dz) and can be decompressed with gunzip. 
(function(){
  const global = (typeof globalThis !== "undefined") ? globalThis : (typeof window !== "undefined" ? window : this);

  const utf8 = new TextDecoder("utf-8");

  function parseIfo(text) {
    const meta = {};
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([^=]+)=(.*)$/);
      if (m) meta[m[1].trim()] = m[2].trim();
    }
    return meta;
  }

  async function fetchText(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  }

  async function fetchArrayBuffer(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.arrayBuffer();
  }

  async function fetchGunzipArrayBuffer(url) {
    if (typeof DecompressionStream === "undefined") {
      throw new Error("DecompressionStream('gzip') is not available. Update Firefox or avoid .gz/.dz dictionary files.");
    }
    let r;
    try {
      r = await fetch(url);
    } catch (e) {
      if ((e && e.name) === "AbortError") {
        throw new Error(`Fetch aborted for ${url} (AbortError).`);
      }
      throw e;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    if (!r.body) throw new Error(`No readable stream for ${url}`);

    let decompressed;
    try {
      decompressed = r.body.pipeThrough(new DecompressionStream("gzip"));
    } catch (e) {
      throw new Error(`Failed to create gzip decompression stream: ${e?.message || e}`);
    }

    try {
      return await new Response(decompressed).arrayBuffer();
    } catch (e) {
      if ((e && e.name) === "AbortError") {
        throw new Error(`Decompression aborted for ${url} (AbortError). Possible causes: corrupt .gz/.dz file or memory pressure.`);
      }
      throw new Error(`Decompression failed for ${url}: ${e?.message || e}`);
    }
  }

  function isGzLike(url) { return url.endsWith(".gz") || url.endsWith(".dz"); }

  async function fetchMaybeInflate(url) {
    return isGzLike(url) ? await fetchGunzipArrayBuffer(url) : await fetchArrayBuffer(url);
  }

  function parseIdx(idxBuffer) {
    // .idx format: word\0 + uint32(offset) + uint32(size), big-endian (network byte order). 
    const bytes = new Uint8Array(idxBuffer);
    const view = new DataView(idxBuffer);
    const entries = [];
    let i = 0;
    while (i < bytes.length) {
      const start = i;
      while (i < bytes.length && bytes[i] !== 0) i++;
      const word = utf8.decode(bytes.subarray(start, i));
      i++; // skip \0
      if (i + 8 > bytes.length) break;
      const offset = view.getUint32(i, false); i += 4;
      const size   = view.getUint32(i, false); i += 4;
      entries.push({ word, offset, size });
    }
    return entries;
  }

  function buildLowerMap(entries) {
    const map = new Map();
    for (const e of entries) {
      const k = e.word.toLowerCase();
      if (!map.has(k)) map.set(k, e);
    }
    return map;
  }

  function decodeDictEntry(dictBytes, entry, ifoMeta) {
    const slice = dictBytes.subarray(entry.offset, entry.offset + entry.size);
    let s = utf8.decode(slice);
    s = s.replace(/\0+$/g, "");
    return s.trim();
  }

  function htmlToText(s) {
    if (!s) return "";
    // Preserve separators when stripping HTML (avoid word concatenation like "позволятьпозволить").
    s = String(s);

    // Line breaks / blocks
    s = s.replace(/<\s*br\s*\/?\s*>/gi, "\n");
    s = s.replace(/<\s*(p|div|li|tr|table|ul|ol|h\d)[^>]*>/gi, "\n");
    s = s.replace(/<\/\s*(p|div|li|tr|table|ul|ol|h\d)\s*>/gi, "\n");

    // Inline closings should add a space to prevent concatenation
    s = s.replace(/<\/\s*(b|strong|i|em|span|a|sup|sub|code)\s*>/gi, " ");
    s = s.replace(/<\s*(b|strong|i|em|span|a|sup|sub|code)[^>]*>/gi, "");

    // Any other tag -> space
    s = s.replace(/<[^>]+>/g, " ");

    // Basic entities
    s = s.replace(/&nbsp;/gi, " ")
         .replace(/&amp;/gi, "&")
         .replace(/&lt;/gi, "<")
         .replace(/&gt;/gi, ">")
         .replace(/&quot;/gi, "\"")
         .replace(/&#039;/gi, "'");

    return s;
  }
function normalizeDefinition(defText) {
    let s = htmlToText(defText || "");
    s = s.replace(/\r/g, "");
    // StarDict entries often use tabs to separate fields (headword, phonetic, part of speech, etc.)
    s = s.replace(/\0+/g, "\n");
    s = s.replace(/\t+/g, "\n");

    // Fix common "stuck" boundaries:
    // 1) sentence end before Cyrillic: "...function.действие" -> newline before Russian
    s = s.replace(/\.(?=[А-Яа-яЁё])/g, ".\n");

    // 2) Cyrillic immediately followed by Latin (next sense): "действиеA planned" -> newline
    s = s.replace(/(?<=[А-Яа-яЁё])(?=[A-Z])/g, "\n");

    // 3) Part-of-speech glued to definition: "nounThe method" -> "noun\nThe method"
    const pos = "(noun|verb|adjective|adj\.?|adverb|adv\.?|pronoun|pron\.?|preposition|prep\.?|conjunction|conj\.?|interjection|interj\.?|article|det\.?|numeral|num\.?|participle|part\.?|modal)";
    s = s.replace(new RegExp(`\\b${pos}(?=[A-ZА-Я])`, "gi"), (m) => m + "\n");

    // Collapse excessive spaces
    s = s.replace(/\]\s*(?=[А-Яа-яЁё])/g, "] ");
    s = s.replace(/(?<=[А-Яа-яЁё])\[/g, " [");
    s = s.replace(/[ \u00A0]{2,}/g, " ");

    // Normalize newlines
    s = s.replace(/\n{3,}/g, "\n\n").trim();
    return s;
  }

  function splitToLines(defText) {
    const s = normalizeDefinition(defText);
    let parts = s.split(/\n+/).map(x => x.trim()).filter(Boolean);

    // If still one long line, try splitting by "; " and by ") " after parentheses groups.
    if (parts.length <= 1) {
      const t = parts[0] || "";
      parts = t.split(/;\s+/).map(x => x.trim()).filter(Boolean);
    }
    if (parts.length <= 1) {
      const t = parts[0] || "";
      parts = t.split(/\)\s+(?=[A-ZА-Я])/).map(x => x.trim()).filter(Boolean);
    }

    return parts.slice(0, 30);
  }
  global.StarDict = { parseIfo, fetchText, fetchMaybeInflate, parseIdx, buildLowerMap, decodeDictEntry, splitToLines };
})();
