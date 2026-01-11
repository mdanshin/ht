// Content script: detects word under cursor or selection and shows tooltip.

const DEFAULTS = {
  // Default trigger: show tooltip on hover (no modifier keys).
  // Can be changed in Options.
  trigger: "hover",
  delayMs: 350,
  maxWidth: 480,
  showSource: true,
  showOriginal: true,
  disableOnEditable: true
};

let settings = { ...DEFAULTS };
let hoverTimer = null;
let lastMouse = { x: 0, y: 0 };
let lastRequestId = 0;

// Tooltip needs to be clickable for the pronunciation button.
// We'll pause hover-hide logic while the pointer is over the tooltip.
let isOverTooltip = false;
let currentTooltipWord = null;
let currentTooltipMode = null; // "word" | "phrase"

// Audio playback state (one at a time).
let audioPlayer = null;
const audioCache = new Map(); // word -> { audioUrl, phonetic, sourceUrl, license }

function isEditableTarget(el) {
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea") return true;
  if (el.isContentEditable) return true;
  return false;
}

function loadSettings() {
  browser.storage.local.get(Object.keys(DEFAULTS)).then(stored => {
    settings = { ...DEFAULTS, ...stored };
    applyMaxWidth();
  });
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let changed = false;
  for (const k of Object.keys(DEFAULTS)) {
    if (changes[k]) { settings[k] = changes[k].newValue; changed = true; }
  }
  if (changed) applyMaxWidth();
});

function createTooltip() {
  const host = document.createElement("div");
  host.id = "__enru_hover_translate_host__";
  host.style.position = "fixed";
  host.style.left = "0";
  host.style.top = "0";
  host.style.zIndex = "2147483647";
  host.style.pointerEvents = "auto";

  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .tip {
      position: fixed;
      max-width: ${settings.maxWidth}px;
      min-width: 320px;
      word-break: normal;
      overflow-wrap: break-word;
      hyphens: none;
      padding: 14px 16px;
      border-radius: 16px;
      font: 13px/1.55 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      white-space: normal;
      pointer-events: auto;
      transform: translate3d(0,0,0);
      opacity: 0;
      transition: opacity 90ms ease;

      /* Liquid glass */
      isolation: isolate;
      overflow: hidden;
      color: rgba(12, 13, 16, 0.92);
      border: 1px solid rgba(255,255,255,0.38);
      box-shadow:
        0 18px 45px rgba(0,0,0,0.20),
        inset 0 1px 0 rgba(255,255,255,0.55),
        inset 0 -1px 0 rgba(255,255,255,0.14);
      background:
        radial-gradient(140px 90px at 18% 12%, rgba(255,255,255,0.55), rgba(255,255,255,0) 65%),
        radial-gradient(220px 140px at 92% -10%, rgba(255,255,255,0.45), rgba(255,255,255,0) 70%),
        linear-gradient(135deg, rgba(255,255,255,0.34), rgba(255,255,255,0.12));
    }

    @supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
      .tip {
        -webkit-backdrop-filter: blur(18px) saturate(165%);
        backdrop-filter: blur(18px) saturate(165%);
      }
    }

    @supports not ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
      .tip {
        background: rgba(245,246,250,0.96);
      }
    }

    /* Specular highlights */
    .tip::before {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      z-index: 0;
      background:
        linear-gradient(to bottom, rgba(255,255,255,0.58), rgba(255,255,255,0) 42%),
        radial-gradient(260px 120px at 42% 0%, rgba(255,255,255,0.35), rgba(255,255,255,0) 70%);
      opacity: 0.55;
    }
    .tip::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      pointer-events: none;
      z-index: 0;
      background:
        radial-gradient(240px 180px at 110% 120%, rgba(120,170,255,0.20), rgba(255,255,255,0) 65%),
        radial-gradient(180px 140px at -10% 120%, rgba(255,180,220,0.14), rgba(255,255,255,0) 70%);
      opacity: 0.50;
    }

    .tip > * { position: relative; z-index: 1; }

    @media (prefers-color-scheme: dark) {
      .tip {
        color: rgba(255,255,255,0.92);
        border: 1px solid rgba(255,255,255,0.18);
        box-shadow:
          0 20px 55px rgba(0,0,0,0.38),
          inset 0 1px 0 rgba(255,255,255,0.20),
          inset 0 -1px 0 rgba(255,255,255,0.10);
        background:
          radial-gradient(160px 120px at 18% 10%, rgba(255,255,255,0.22), rgba(255,255,255,0) 60%),
          radial-gradient(260px 160px at 92% -15%, rgba(180,210,255,0.18), rgba(255,255,255,0) 70%),
          linear-gradient(135deg, rgba(16,18,24,0.62), rgba(10,11,16,0.26));
      }
      .tip::before { opacity: 0.35; }
      .tip::after  { opacity: 0.42; }
    }

    .tip.show { opacity: 1; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .word { font-weight: 650; letter-spacing: 0.01em; }

    .src {
      margin-left: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      border: 1px solid rgba(255,255,255,0.28);
      background: rgba(255,255,255,0.20);
      color: inherit;
      opacity: 0.88;
    }

    @supports ((-webkit-backdrop-filter: blur(1px)) or (backdrop-filter: blur(1px))) {
      .src {
        -webkit-backdrop-filter: blur(10px) saturate(140%);
        backdrop-filter: blur(10px) saturate(140%);
      }
    }

    .phon { opacity: 0.82; margin-top: 6px; font-size: 12px; }
    .pos { margin-top: 10px; opacity: 0.70; font-size: 11px; letter-spacing: 0.10em; }
    .item { margin-top: 10px; overflow-wrap: break-word; word-break: normal; }
    .dot { opacity: 0.65; margin-right: 6px; }
    .en { display: inline; }
    .ru { margin-left: 18px; margin-top: 5px; opacity: 0.88; }
    .ruLine { margin-top: 3px; }

    .audioBtn {
      margin-left: 4px;
      border: 1px solid rgba(255,255,255,0.30);
      background: rgba(255,255,255,0.18);
      color: inherit;
      border-radius: 12px;
      padding: 5px 10px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      pointer-events: auto;
      box-shadow:
        0 8px 18px rgba(0,0,0,0.10),
        inset 0 1px 0 rgba(255,255,255,0.45);
    }
    .audioBtn:hover { background: rgba(255,255,255,0.25); }
    .audioBtn:active { transform: translateY(1px); }
    .audioBtn:focus-visible { outline: 2px solid rgba(120,170,255,0.55); outline-offset: 2px; }
    .audioBtn[aria-busy="true"] { opacity: 0.7; cursor: progress; }
    .audioIcon { width: 16px; height: 16px; display: inline-block; }
    .audioLabel { font-size: 11px; opacity: 0.9; }
    .audioErr { margin-top: 8px; font-size: 12px; opacity: 0.90; color: rgba(255, 120, 120, 0.92); }

  `;
  shadow.appendChild(style);

  const tip = document.createElement("div");
  tip.className = "tip";
  tip.style.left = "-9999px";
  tip.style.top = "-9999px";
  shadow.appendChild(tip);

  // Keep tooltip visible while interacting with it.
  tip.addEventListener("mouseenter", () => {
    isOverTooltip = true;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  }, { passive: true });
  tip.addEventListener("mouseleave", () => { isOverTooltip = false; }, { passive: true });
  tip.addEventListener("click", onTooltipClick);

  document.documentElement.appendChild(host);
  return { host, tip };
}

const tooltip = createTooltip();

function applyMaxWidth() { tooltip.tip.style.maxWidth = `${settings.maxWidth}px`; }

function hideTooltip() {
  tooltip.tip.classList.remove("show");
  tooltip.tip.style.left = "-9999px";
  tooltip.tip.style.top = "-9999px";
  isOverTooltip = false;
  currentTooltipWord = null;
  currentTooltipMode = null;

  // Optional: stop any ongoing pronunciation when tooltip is dismissed.
  try { stopAudio(); } catch (e) {}
  try { if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); } catch (e) {}
}

function getWordAtPoint(x, y, evForAltKey) {
  const el = document.elementFromPoint(x, y);
  if (settings.disableOnEditable && isEditableTarget(el)) return null;

  let range = null;
  if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (!pos || !pos.offsetNode || pos.offsetNode.nodeType !== Node.TEXT_NODE) return null;
    range = document.createRange();
    range.setStart(pos.offsetNode, pos.offset);
    range.setEnd(pos.offsetNode, pos.offset);
  } else if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(x, y);
    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
  }
  if (!range) return null;

  const textNode = range.startContainer;
  const text = textNode.nodeValue || "";
  let i = range.startOffset;

  if (i > 0 && /\s/.test(text[i]) && !/\s/.test(text[i - 1])) i -= 1;
  if (i < text.length && /\s/.test(text[i]) && i + 1 < text.length && !/\s/.test(text[i + 1])) i += 1;

  const isWordChar = (ch) => /[A-Za-z’'\-]/.test(ch);
  if (!isWordChar(text[i])) return null;

  let start = i;
  while (start > 0 && isWordChar(text[start - 1])) start--;

  let end = i;
  while (end < text.length && isWordChar(text[end])) end++;

  const raw = text.slice(start, end);
  const word = raw.replace(/^[’']+|[’']+$/g, "");
  if (!/[A-Za-z]/.test(word)) return null;

  // Safety: caretPositionFromPoint() may "snap" to the nearest text insertion point.
  // Only show tooltip if the pointer is actually over the word's rendered bounding box.
  try {
    const wordRange = document.createRange();
    wordRange.setStart(textNode, start);
    wordRange.setEnd(textNode, end);
    const rects = Array.from(wordRange.getClientRects());
    if (!rects.length || !pointInAnyRect(x, y, rects, 3)) return null;
  } catch (e) {
    // If range measurement fails, fall back to previous behavior.
  }

  return word;
}


function pointInAnyRect(x, y, rectList, pad = 2) {
  for (const r of rectList) {
    if (x >= (r.left - pad) && x <= (r.right + pad) && y >= (r.top - pad) && y <= (r.bottom + pad)) {
      return true;
    }
  }
  return false;
}

async function translateAndShow(word, x, y) {
  const reqId = ++lastRequestId;
  const resp = await browser.runtime.sendMessage({ type: "translate", word });
  if (reqId !== lastRequestId) return;

  const result = resp?.result;
  if (!result || !result.translation || !result.translation.length) { hideTooltip(); return; }

  const rawLines = result.translation.slice(0, 24);
  const renderedEl = renderDefinitionDom(rawLines, word);

  currentTooltipWord = word;
  currentTooltipMode = "word";

  // Build tooltip content without innerHTML (AMO linter).
  tooltip.tip.textContent = "";
  const rowEl = document.createElement("div");
  rowEl.className = "row";

  if (settings.showOriginal) {
    const w = document.createElement("span");
    w.className = "word";
    w.textContent = word;
    rowEl.appendChild(w);
  }

  const btn = document.createElement("button");
  btn.className = "audioBtn";
  btn.dataset.action = "pronounce";
  btn.title = "Pronounce";
  btn.setAttribute("aria-label", "Pronounce");

  const icon = document.createElement("span");
  icon.className = "audioIcon";
  icon.setAttribute("aria-hidden", "true");
  const svg = createSpeakerSvg();
  if (svg) icon.appendChild(svg);
  else icon.textContent = "🔊";

  const label = document.createElement("span");
  label.className = "audioLabel";
  label.textContent = "▶";

  btn.appendChild(icon);
  btn.appendChild(label);
  rowEl.appendChild(btn);

  if (settings.showSource) {
    const s = document.createElement("span");
    s.className = "src";
    s.textContent = String(result.source || "");
    rowEl.appendChild(s);
  }

  tooltip.tip.appendChild(rowEl);
  if (renderedEl) tooltip.tip.appendChild(renderedEl);

  const offset = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  tooltip.tip.style.left = "0px";
  tooltip.tip.style.top = "0px";
  tooltip.tip.classList.add("show");

  const rect = tooltip.tip.getBoundingClientRect();
  let left = x + offset;
  let top = y + offset;

  if (left + rect.width + 8 > vw) left = Math.max(8, vw - rect.width - 8);
  if (top + rect.height + 8 > vh) top = Math.max(8, y - rect.height - offset);

  tooltip.tip.style.left = `${left}px`;
  tooltip.tip.style.top = `${top}px`;
}

function isPhraseLike(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  // At least two tokens or contains punctuation typical for sentences.
  return /\s/.test(t) || /[\.,;:!?]/.test(t);
}

async function translateSelectionAndShow(text, anchorRect, mouseX, mouseY) {
  const reqId = ++lastRequestId;
  const resp = await browser.runtime.sendMessage({ type: "translateText", text });
  if (reqId !== lastRequestId) return;

  const result = resp?.result;
  if (!result || !result.translation || !result.translation.length) { hideTooltip(); return; }

  currentTooltipWord = null;
  currentTooltipMode = "phrase";

  const original = String(text).replace(/\s+/g, " ").trim();
  const translated = String(result.translation[0] || "").trim();

  // Build tooltip content without innerHTML (AMO linter).
  tooltip.tip.textContent = "";

  const rowEl = document.createElement("div");
  rowEl.className = "row";
  const labelEl = document.createElement("span");
  labelEl.className = "word";
  labelEl.textContent = "Фраза";
  rowEl.appendChild(labelEl);

  if (settings.showSource) {
    const s = document.createElement("span");
    s.className = "src";
    s.textContent = String(result.source || "");
    rowEl.appendChild(s);
  }
  tooltip.tip.appendChild(rowEl);

  const item = document.createElement("div");
  item.className = "item";
  const dot = document.createElement("span");
  dot.className = "dot";
  dot.textContent = "•";
  const en = document.createElement("span");
  en.className = "en";
  en.textContent = original;
  item.appendChild(dot);
  item.appendChild(en);
  tooltip.tip.appendChild(item);

  const ru = document.createElement("div");
  ru.className = "ru";
  const ruLine = document.createElement("div");
  ruLine.className = "ruLine";
  ruLine.textContent = `— ${translated}`;
  ru.appendChild(ruLine);
  tooltip.tip.appendChild(ru);

  const offset = 14;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  tooltip.tip.style.left = "0px";
  tooltip.tip.style.top = "0px";
  tooltip.tip.classList.add("show");

  const rect = tooltip.tip.getBoundingClientRect();
  let left = mouseX + offset;
  let top = mouseY + offset;

  if (anchorRect && anchorRect.width && anchorRect.height) {
    left = anchorRect.left;
    top = anchorRect.bottom + 8;
  }

  if (left + rect.width + 8 > vw) left = Math.max(8, vw - rect.width - 8);
  if (top + rect.height + 8 > vh) top = Math.max(8, (anchorRect?.top || mouseY) - rect.height - 10);

  tooltip.tip.style.left = `${Math.round(left)}px`;
  tooltip.tip.style.top = `${Math.round(top)}px`;
}

function selectionIsInEditable(sel) {
  try {
    const node = sel?.anchorNode;
    const el = (node && node.nodeType === Node.ELEMENT_NODE) ? node : node?.parentElement;
    return !!(el && isEditableTarget(el));
  } catch (e) {
    return false;
  }
}

function maybeTranslateSelection(ev) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) {
    // If the phrase tooltip is shown and selection is cleared, hide it.
    if (currentTooltipMode === "phrase" && !isOverTooltip) hideTooltip();
    return;
  }

  if (settings.disableOnEditable && selectionIsInEditable(sel)) return;

  const text = (sel.toString() || "").trim();
  if (!text) return;
  if (!/[A-Za-z]/.test(text)) return;
  if (!isPhraseLike(text)) return;

  let rect = null;
  try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) {}

  // Use current pointer position if available.
  const mx = ev?.clientX ?? lastMouse.x;
  const my = ev?.clientY ?? lastMouse.y;

  translateSelectionAndShow(text, rect, mx, my).catch(() => {});
}

const SPEAKER_SVG = `
<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M11 5L6.5 9H3v6h3.5L11 19V5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
  <path d="M15 9.5c.8.8 1.2 1.8 1.2 2.8S15.8 14.3 15 15.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M17.7 7.3c1.6 1.6 2.3 3.2 2.3 5s-.7 3.4-2.3 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

function createSpeakerSvg() {
  try {
    const doc = new DOMParser().parseFromString(SPEAKER_SVG, "image/svg+xml");
    const svg = doc && doc.documentElement;
    if (svg && svg.nodeName && svg.nodeName.toLowerCase() === "svg") {
      return document.importNode(svg, true);
    }
  } catch (e) {}
  return null;
}


function onTooltipClick(ev) {
  const path = (ev.composedPath && ev.composedPath()) || [];
  const btn = path.find(n => n && n.dataset && n.dataset.action === "pronounce");
  if (!btn) return;

  ev.preventDefault();
  ev.stopPropagation();

  const word = currentTooltipWord;
  if (!word) return;
  playPronunciation(word).catch(() => {});
}

function stopAudio() {
  try {
    if (audioPlayer) {
      audioPlayer.pause();
      audioPlayer.currentTime = 0;
    }
  } catch (e) {}
  audioPlayer = null;
}

async function playPronunciation(word) {
  // Toggle off if already playing.
  if (audioPlayer && !audioPlayer.paused) {
    stopAudio();
    setAudioBusy(false);
    return;
  }

  clearAudioError();
  setAudioBusy(true);

  let audio = audioCache.get(word);
  if (!audio) {
    const resp = await browser.runtime.sendMessage({ type: "pronounce", word });
    audio = resp?.audio || null;
    audioCache.set(word, audio);
  }

  if (audio?.audioUrl) {
    try {
      stopAudio();
      audioPlayer = new Audio(audio.audioUrl);
      audioPlayer.preload = "none";

      await audioPlayer.play();
      audioPlayer.addEventListener("ended", () => { setAudioBusy(false); }, { once: true });
      audioPlayer.addEventListener("error", () => {
        setAudioBusy(false);
        showAudioError("Не получилось воспроизвести аудио (ошибка загрузки).");
      }, { once: true });
      return;
    } catch (e) {
      // Fall through to TTS.
    }
  }

  // Fallback: built-in Web Speech (local TTS, no network).
  try {
    if (typeof speechSynthesis !== "undefined") {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(word);
      u.lang = "en-US";
      u.rate = 0.95;
      u.onend = () => setAudioBusy(false);
      u.onerror = () => {
        setAudioBusy(false);
        showAudioError("Нет аудио для этого слова (и TTS тоже не сработал).");
      };
      speechSynthesis.speak(u);
      return;
    }
  } catch (e) {}

  setAudioBusy(false);
  showAudioError("Нет доступного источника произношения для этого слова.");
}

function setAudioBusy(busy) {
  const btn = tooltip.tip.querySelector('[data-action="pronounce"]');
  if (!btn) return;
  btn.setAttribute("aria-busy", busy ? "true" : "false");
  const label = btn.querySelector(".audioLabel");
  if (label) label.textContent = busy ? "…" : "▶";
}

function clearAudioError() {
  const el = tooltip.tip.querySelector(".audioErr");
  if (el) el.remove();
}

function showAudioError(msg) {
  clearAudioError();
  const wrap = document.createElement("div");
  wrap.className = "audioErr";
  wrap.textContent = msg;
  tooltip.tip.appendChild(wrap);
}



function renderDefinitionDom(lines, word) {
  const posNames = [
    "noun","verb","adjective","adj","adverb","adv","pronoun","pron","preposition","prep",
    "conjunction","conj","interjection","interj","article","det","numeral","num","participle","part","modal"
  ];
  const posSet = new Set(posNames);
  const posRe = new RegExp(`^(${posNames.join("|")})(\\b|\\()`, "i");

  const cleaned = (lines || [])
    .map(s => String(s || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Drop leading headword repetition
  const wl = (word || "").toLowerCase();
  if (cleaned.length && wl && cleaned[0].toLowerCase().startsWith(wl)) {
    cleaned[0] = cleaned[0].slice(word.length).trim();
  }

  // Phonetics often come first
  let phon = null;
  if (cleaned.length) {
    const c0 = cleaned[0];
    if (/\[[^\]]+\]/.test(c0) || /\/[A-Za-zəɪʊɔæʌɛɜːʃʒθðŋ]+\//.test(c0)) {
      phon = c0;
      cleaned.shift();
    }
  }

  const blocks = [];
  let current = { pos: null, items: [] };
  const flush = () => {
    if (current.pos || current.items.length) blocks.push(current);
    current = { pos: null, items: [] };
  };

  for (const line of cleaned) {
    const m = line.match(posRe);
    if (m) {
      flush();
      const key = m[1].toLowerCase();
      const rest = line.slice(m[1].length).trim();
      const label = key.toUpperCase() + (rest ? (" " + rest) : "");
      current.pos = label;
      continue;
    }

    const key = line.toLowerCase().replace(/\.$/, "");
    if (posSet.has(key)) {
      flush();
      current.pos = key.toUpperCase();
      continue;
    }
    current.items.push(line);
  }
  flush();

  const hasLatin = (s) => /[A-Za-z]/.test(s);
  const hasCyr = (s) => /[А-Яа-яЁё]/.test(s);
  const isRuLine = (s) => hasCyr(s) && !hasLatin(s);

  const container = document.createElement("div");
  if (phon) {
    const el = document.createElement("div");
    el.className = "phon";
    el.textContent = phon;
    container.appendChild(el);
  }

  for (const b of blocks) {
    if (b.pos) {
      const posEl = document.createElement("div");
      posEl.className = "pos";
      posEl.textContent = b.pos;
      container.appendChild(posEl);
    }

    const bullets = [];
    for (const raw of b.items) {
      const s = raw.trim();
      if (!s) continue;
      if (isRuLine(s) && bullets.length) {
        bullets[bullets.length - 1].ru.push(s);
      } else {
        bullets.push({ en: s, ru: [] });
      }
    }

    for (const bl of bullets.slice(0, 8)) {
      if (bl.en) {
        const item = document.createElement("div");
        item.className = "item";
        const dot = document.createElement("span");
        dot.className = "dot";
        dot.textContent = "•";
        const en = document.createElement("span");
        en.className = "en";
        en.textContent = bl.en;
        item.appendChild(dot);
        item.appendChild(en);
        container.appendChild(item);
      }

      if (bl.ru && bl.ru.length) {
        const uniq = [];
        for (const r of bl.ru) {
          if (!uniq.includes(r)) uniq.push(r);
        }
        const ru = document.createElement("div");
        ru.className = "ru";
        for (const r of uniq.slice(0, 4)) {
          const ruLine = document.createElement("div");
          ruLine.className = "ruLine";
          ruLine.textContent = `— ${r}`;
          ru.appendChild(ruLine);
        }
        container.appendChild(ru);
      }
    }
  }

  return container;
}

function renderDefinition(lines, word) {
  const posNames = [
    "noun","verb","adjective","adj","adverb","adv","pronoun","pron","preposition","prep",
    "conjunction","conj","interjection","interj","article","det","numeral","num","participle","part","modal"
  ];
  const posSet = new Set(posNames);
  const posRe = new RegExp(`^(${posNames.join("|")})(\\b|\\()`, "i");

  const cleaned = (lines || [])
    .map(s => String(s || "").replace(/\s+/g, " ").trim())
    .filter(Boolean);

  // Drop leading headword repetition
  const wl = (word || "").toLowerCase();
  if (cleaned.length && wl && cleaned[0].toLowerCase().startsWith(wl)) {
    cleaned[0] = cleaned[0].slice(word.length).trim();
  }

  // Phonetics often come first
  let phon = null;
  if (cleaned.length) {
    const c0 = cleaned[0];
    if (/\[[^\]]+\]/.test(c0) || /\/[A-Za-zəɪʊɔæʌɛɜːʃʒθðŋ]+\//.test(c0)) {
      phon = c0;
      cleaned.shift();
    }
  }

  const blocks = [];
  let current = { pos: null, items: [] };

  const flush = () => {
    if (current.pos || current.items.length) blocks.push(current);
    current = { pos: null, items: [] };
  };

  for (const line of cleaned) {
    const m = line.match(posRe);
    if (m) {
      flush();
      const key = m[1].toLowerCase();
      const rest = line.slice(m[1].length).trim();
      const label = key.toUpperCase() + (rest ? (" " + rest) : "");
      current.pos = label;
      continue;
    }

    const key = line.toLowerCase().replace(/\.$/, "");
    if (posSet.has(key)) {
      flush();
      current.pos = key.toUpperCase();
      continue;
    }

    current.items.push(line);
  }
  flush();

  const hasLatin = (s) => /[A-Za-z]/.test(s);
  const hasCyr = (s) => /[А-Яа-яЁё]/.test(s);
  const isRuLine = (s) => hasCyr(s) && !hasLatin(s);

  const body = [];
  if (phon) body.push(`<div class="phon">${escapeHtml(phon)}</div>`);

  for (const b of blocks) {
    if (b.pos) body.push(`<div class="pos">${escapeHtml(b.pos)}</div>`);

    const bullets = [];
    for (const raw of b.items) {
      const s = raw.trim();
      if (!s) continue;

      if (isRuLine(s) && bullets.length) {
        bullets[bullets.length - 1].ru.push(s);
      } else {
        bullets.push({ en: s, ru: [] });
      }
    }

    for (const bl of bullets.slice(0, 8)) {
      if (bl.en) {
        body.push(`<div class="item"><span class="dot">•</span><span class="en">${escapeHtml(bl.en)}</span></div>`);
      }
      if (bl.ru && bl.ru.length) {
        const uniq = [];
        for (const r of bl.ru) {
          if (!uniq.includes(r)) uniq.push(r);
        }
        const ruHtml = uniq.slice(0, 4).map(r => `<div class="ruLine">— ${escapeHtml(r)}</div>`).join("");
        body.push(`<div class="ru">${ruHtml}</div>`);
      }
    }
  }

  return body.length ? `<div>${body.join("")}</div>` : "";
}


function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function scheduleHoverCheck(ev) {
  lastMouse = { x: ev.clientX, y: ev.clientY };
  if (hoverTimer) clearTimeout(hoverTimer);

  hoverTimer = setTimeout(async () => {
    hoverTimer = null;

    // If user has a phrase selected, don't fight with selection translation.
    try {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && isPhraseLike(sel.toString())) return;
    } catch (e) {}

    // Don't auto-hide/refresh while the user is interacting with the tooltip.
    if (isOverTooltip) return;

    if (settings.trigger === "altHover" && !ev.altKey) {
      hideTooltip();
      return;
    }

    const word = getWordAtPoint(lastMouse.x, lastMouse.y, ev);
    if (!word) { hideTooltip(); return; }

    await translateAndShow(word, lastMouse.x, lastMouse.y);
  }, settings.delayMs);
}

function onMouseMove(ev) {
  if (settings.trigger === "doubleClick") return;
  if (isOverTooltip) return;
  scheduleHoverCheck(ev);
}

function onKeyUpOrDown(ev) {
  if (settings.trigger !== "altHover") return;
  if (!ev.altKey) hideTooltip();
}

function onDblClick(ev) {
  if (settings.trigger !== "doubleClick") return;
  const sel = (window.getSelection()?.toString() || "").trim();
  const word = sel && /^[A-Za-z][A-Za-z’'\-]{0,40}$/.test(sel) ? sel : getWordAtPoint(ev.clientX, ev.clientY, ev);
  if (!word) { hideTooltip(); return; }
  translateAndShow(word, ev.clientX, ev.clientY);
}

function onScrollOrResize() { hideTooltip(); }

document.addEventListener("mousemove", onMouseMove, { passive: true });
document.addEventListener("dblclick", onDblClick, { passive: true });
document.addEventListener("keydown", onKeyUpOrDown, { passive: true });
document.addEventListener("keyup", (ev) => {
  onKeyUpOrDown(ev);
  // Also support translating selected phrases created via keyboard selection.
  try { maybeTranslateSelection(ev); } catch (e) {}
}, { passive: true });
document.addEventListener("mouseup", (ev) => {
  // Let the selection settle first.
  try {
    lastMouse = { x: ev.clientX, y: ev.clientY };
    setTimeout(() => { maybeTranslateSelection(ev); }, 0);
  } catch (e) {}
}, { passive: true });
window.addEventListener("scroll", onScrollOrResize, { passive: true });
window.addEventListener("resize", onScrollOrResize, { passive: true });

loadSettings();
applyMaxWidth();