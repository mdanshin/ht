// Offline StarDict (ifo + idx.gz + dict.dz) + optional MyMemory fallback.
// Put files under /dict:
//   dict/eng-rus.ifo
//   dict/eng-rus.idx.gz
//   dict/eng-rus.dict.dz
// StarDict: .idx/.idx.gz and .dict/.dict.dz supported; offsets/sizes are 32-bit network byte order. 

const DEFAULTS = { onlineFallback: false };
const BASE = "dict/eng-rus"; // change if you rename files

const IFO_URL  = browser.runtime.getURL(`${BASE}.ifo`);
const IDX_URL  = browser.runtime.getURL(`${BASE}.idx.gz`);
const DICT_URL = browser.runtime.getURL(`${BASE}.dict.dz`);

const MYMEMORY_ENDPOINT = "https://api.mymemory.translated.net/get";

// Free pronunciation/audio source (Wiktionary-backed).
// Docs/landing: https://dictionaryapi.dev/ (no API key).
const DICTAPI_ENDPOINT = "https://api.dictionaryapi.dev/api/v2/entries/en/";

let settings = { ...DEFAULTS };

let ifoMeta = null;
let idxMap = null;    // Map<lowerWord, {offset,size}>
let dictBytes = null; // Uint8Array (uncompressed dict)
let loadState = { loading: false, loaded: false, error: null };
let debugLast = { stage: 'init', detail: '' };

const cache = new Map();
const textCache = new Map();
const audioCache = new Map();
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

function now() { return Date.now(); }

async function loadSettings() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  settings = { ...DEFAULTS, ...stored };
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const k of Object.keys(DEFAULTS)) {
    if (changes[k]) settings[k] = changes[k].newValue;
  }
});

async function ensureDictionaryLoaded() {
  debugLast = { stage: 'start', detail: '' };
  if (loadState.loaded) return true;
  if (loadState.loading) return false;

  loadState.loading = true;
  loadState.error = null;

  try {
    debugLast = { stage: 'ifo_fetch', detail: IFO_URL };
    const ifoText = await StarDict.fetchText(IFO_URL);
    debugLast = { stage: 'ifo_parse', detail: `len=${ifoText.length}` };
    ifoMeta = StarDict.parseIfo(ifoText);

    debugLast = { stage: 'idx_fetch', detail: IDX_URL };

    const idxBuf = await StarDict.fetchMaybeInflate(IDX_URL);
    debugLast = { stage: 'idx_parse', detail: `bytes=${idxBuf.byteLength}` };
    const entries = StarDict.parseIdx(idxBuf);
    debugLast = { stage: 'idx_map', detail: `entries=${entries.length}` };
    idxMap = StarDict.buildLowerMap(entries);

    debugLast = { stage: 'dict_fetch', detail: DICT_URL };

    const dictBuf = await StarDict.fetchMaybeInflate(DICT_URL);
    debugLast = { stage: 'dict_ready', detail: `bytes=${dictBuf.byteLength}` };
    dictBytes = new Uint8Array(dictBuf);

    loadState.loaded = true;
    debugLast = { stage: 'loaded', detail: `words=${idxMap.size}` };
    return true;
  } catch (e) {
    loadState.error = `stage=${debugLast?.stage} detail=${debugLast?.detail} :: ${String(e?.message || e)}`;
    console.warn("StarDict load failed:", loadState.error);
    loadState.loaded = false;
    return false;
  } finally {
    loadState.loading = false;
  }
}

function normalizeWord(raw) {
  if (!raw) return null;
  let w = raw.trim().toLowerCase();
  w = w.replace(/^[^a-z]+|[^a-z]+$/g, "");
  if (!w) return null;
  if (w.length > 40) return null;
  return w;
}

function normalizeText(raw) {
  if (raw == null) return null;
  // Collapse whitespace, keep punctuation.
  let t = String(raw).replace(/\s+/g, " ").trim();
  if (!t) return null;
  // Keep requests reasonably small to avoid quota/rate issues.
  if (t.length > 300) t = t.slice(0, 300);
  return t;
}

function guessVariants(w) {
  const out = [w];
  if (w.endsWith("'s")) out.push(w.slice(0, -2));
  if (w.endsWith("’s")) out.push(w.slice(0, -2));
  if (w.endsWith("ies") && w.length > 4) out.push(w.slice(0, -3) + "y");
  if (w.endsWith("es") && w.length > 3) out.push(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 3) out.push(w.slice(0, -1));
  if (w.endsWith("ied") && w.length > 4) out.push(w.slice(0, -3) + "y");
  if (w.endsWith("ed") && w.length > 3) out.push(w.slice(0, -2));
  if (w.endsWith("ing") && w.length > 5) out.push(w.slice(0, -3));
  if (w.endsWith("ing") && w.length > 6) out.push(w.slice(0, -3) + "e");
  return [...new Set(out)].filter(Boolean);
}

async function lookupOffline(word) {
  const ready = await ensureDictionaryLoaded();
  if (!ready) {
    if (loadState.error) return { error: loadState.error, loading: false };
    return { loading: true };
  }
  const variants = guessVariants(word);
  for (const v of variants) {
    const e = idxMap.get(v);
    if (!e) continue;
    const defText = StarDict.decodeDictEntry(dictBytes, e, ifoMeta);
    const lines = StarDict.splitToLines(defText);
    if (lines.length) return { translation: lines, source: "offline", matched: v };
  }
  return null;
}

async function lookupMyMemory(word) {
  const url = new URL(MYMEMORY_ENDPOINT);
  url.searchParams.set("q", word);
  url.searchParams.set("langpair", "en|ru");
  const r = await fetch(url.toString(), { method: "GET" });
  const data = await r.json();
  const t = data?.responseData?.translatedText;
  if (!t || typeof t !== "string") return null;
  return { translation: [t], source: "online", matched: word };
}

async function translateMyMemoryText(text) {
  const url = new URL(MYMEMORY_ENDPOINT);
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", "en|ru");
  const r = await fetch(url.toString(), { method: "GET" });
  const data = await r.json();
  const t = data?.responseData?.translatedText;
  if (!t || typeof t !== "string") return null;
  return { translation: [t], source: "online", mode: "phrase" };
}

async function lookupPronunciation(word) {
  // Returns: { audioUrl, phonetic, sourceUrl, license } or null
  const url = DICTAPI_ENDPOINT + encodeURIComponent(word);
  const r = await fetch(url, { method: "GET" });
  if (!r.ok) return null;
  const data = await r.json();
  const first = Array.isArray(data) ? data[0] : null;
  const phonetics = first?.phonetics;
  if (!first || !Array.isArray(phonetics) || !phonetics.length) return null;

  // Prefer entries that actually have an audio file.
  for (const p of phonetics) {
    let a = p?.audio;
    if (!a || typeof a !== "string") continue;
    a = a.trim();
    if (!a) continue;
    if (a.startsWith("//")) a = "https:" + a;
    if (!/^https?:/i.test(a)) continue;

    const phonetic = (typeof p?.text === "string" && p.text.trim())
      ? p.text.trim()
      : (typeof first?.phonetic === "string" && first.phonetic.trim() ? first.phonetic.trim() : null);

    const out = {
      audioUrl: a,
      phonetic,
      sourceUrl: (typeof p?.sourceUrl === "string" && p.sourceUrl) ? p.sourceUrl : null,
      license: (p?.license && typeof p.license === "object") ? p.license : null
    };
    return out;
  }

  return null;
}

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg) return;

  if (msg.type === "lastError") {
    return { ok: true, debug: debugLast, loadState, hasDecompressionStream: (typeof DecompressionStream !== "undefined") };
  }

  if (msg.type === "debug") {
    return { ok: true, debug: debugLast, loadState, hasDecompressionStream: (typeof DecompressionStream !== 'undefined') };
  }

  if (msg.type === "selftest") {
    const ok = await ensureDictionaryLoaded();
    if (!ok) return { ok: false, message: loadState.error || "still loading" };
    return { ok: true, message: `loaded, words: ${idxMap.size}` };
  }

  if (msg.type === "pronounce") {
    const w = normalizeWord(msg.word);
    if (!w) return { ok: true, word: msg.word, audio: null };

    const cached = audioCache.get(w);
    if (cached && (now() - cached.ts) < WEEK) {
      return { ok: true, word: msg.word, audio: cached.value };
    }

    let audio = null;
    try {
      audio = await lookupPronunciation(w);
    } catch (e) {
      console.warn("Pronunciation lookup failed:", e);
      audio = null;
    }

    audioCache.set(w, { ts: now(), value: audio });
    return { ok: true, word: msg.word, audio };
  }

  if (msg.type === "translateText") {
    const text = normalizeText(msg.text);
    if (!text) return { ok: true, text: msg.text, result: null };

    const key = `t:${text}`;
    const cached = textCache.get(key);
    if (cached && (now() - cached.ts) < DAY) {
      return { ok: true, text: msg.text, result: cached.value };
    }

    if (!settings.onlineFallback) {
      // Privacy-first default: do nothing unless user explicitly enables online mode.
      const hint = { translation: ["Для перевода фраз включи Online fallback (MyMemory) в настройках."], source: "hint", mode: "phrase" };
      textCache.set(key, { ts: now(), value: hint });
      return { ok: true, text: msg.text, result: hint };
    }

    let result = null;
    try {
      result = await translateMyMemoryText(text);
    } catch (e) {
      console.warn("Online phrase translation failed:", e);
      result = null;
    }

    textCache.set(key, { ts: now(), value: result });
    return { ok: true, text: msg.text, result };
  }

  if (msg.type !== "translate") return;

  const w = normalizeWord(msg.word);
  if (!w) return { ok: true, word: msg.word, result: null };

  const cached = cache.get(w);
  if (cached && (now() - cached.ts) < DAY) {
    return { ok: true, word: msg.word, result: cached.value };
  }

  let result = await lookupOffline(w);

  if (result?.loading) {
    return { ok: true, word: msg.word, result: { translation: ["Loading offline dictionary…"], source: "offline" } };
  }
  if (result?.error) {
    return { ok: true, word: msg.word, result: { translation: [`Offline dictionary error: ${result.error}`], source: "offline" } };
  }

  if (!result && settings.onlineFallback) {
    try { result = await lookupMyMemory(w); } catch (e) { console.warn("Online lookup failed:", e); }
  }

  cache.set(w, { ts: now(), value: result });
  return { ok: true, word: msg.word, result };
});

loadSettings();
