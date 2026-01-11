const DEFAULTS = {
  // Default trigger: show tooltip on hover (no modifier keys).
  // Users can switch to Alt+Hover or Double-click in Options.
  trigger: "hover",
  delayMs: 350,
  maxWidth: 480,
  onlineFallback: false,
  showSource: true,
  showOriginal: true,
  disableOnEditable: true
};

function setStatus(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = cls ? cls : "hint";
}

async function load() {
  const stored = await browser.storage.local.get(Object.keys(DEFAULTS));
  const s = { ...DEFAULTS, ...stored };

  document.querySelectorAll('input[name="trigger"]').forEach(r => {
    r.checked = (r.value === s.trigger);
  });

  document.getElementById("delayMs").value = s.delayMs;
  document.getElementById("maxWidth").value = s.maxWidth;
  document.getElementById("onlineFallback").checked = s.onlineFallback;
  document.getElementById("showSource").checked = s.showSource;
  document.getElementById("showOriginal").checked = s.showOriginal;
  document.getElementById("disableOnEditable").checked = s.disableOnEditable;
}

async function ensureOnlinePermission(enabled) {
  const origin = "https://api.mymemory.translated.net/*";
  if (!enabled) return true;

  // IMPORTANT:
  // Firefox требует, чтобы permissions.request() вызывался *прямо* из обработчика
  // пользовательского ввода. Если сделать любой await/Promise (например, contains)
  // перед request(), то Firefox считает, что вызов уже не связан с user gesture и
  // кидает: "permissions.request may only be called from a user input handler".
  // Поэтому здесь вызываем request() сразу; если доступ уже был выдан ранее,
  // браузер обычно просто вернёт true без повторного промпта.
  const granted = await browser.permissions.request({ origins: [origin] });
  return granted;
}

document.getElementById("save").addEventListener("click", async () => {
  try {
    const trigger = document.querySelector('input[name="trigger"]:checked')?.value || DEFAULTS.trigger;
    const delayMs = Math.max(100, Math.min(2000, parseInt(document.getElementById("delayMs").value, 10) || DEFAULTS.delayMs));
    const maxWidth = Math.max(160, Math.min(900, parseInt(document.getElementById("maxWidth").value, 10) || DEFAULTS.maxWidth));
    const onlineFallback = !!document.getElementById("onlineFallback").checked;
    const showSource = !!document.getElementById("showSource").checked;
    const showOriginal = !!document.getElementById("showOriginal").checked;
    const disableOnEditable = !!document.getElementById("disableOnEditable").checked;

    if (onlineFallback) {
      const ok = await ensureOnlinePermission(true);
      if (!ok) {
        document.getElementById("onlineFallback").checked = false;
        setStatus("status", "Online permission not granted. Saved with offline-only mode.", "warn");
        await browser.storage.local.set({ trigger, delayMs, maxWidth, onlineFallback: false, showSource, showOriginal, disableOnEditable });
        return;
      }
    }

    await browser.storage.local.set({ trigger, delayMs, maxWidth, onlineFallback, showSource, showOriginal, disableOnEditable });
    setStatus("status", "Saved.", "ok");
  } catch (e) {
    setStatus("status", String(e.message || e), "err");
  }
});

document.getElementById("selftest").addEventListener("click", async () => {
  setStatus("testStatus", "Testing…", "hint");
  try {
    const resp = await browser.runtime.sendMessage({ type: "selftest" });
    if (resp?.ok) {
      setStatus("testStatus", `OK: ${resp.message}`, "ok");
    }
    else {
      setStatus("testStatus", `Failed: ${resp?.message || "unknown error"}`, "err");
      try {
        const more = await browser.runtime.sendMessage({ type: "lastError" });
        const d = more?.debug;
        const ls = more?.loadState;
        const has = more?.hasDecompressionStream;
        const msg = `DecompressionStream: ${has ? "yes" : "NO"} | stage: ${d?.stage} | detail: ${d?.detail} | error=${ls?.error || ""}`;
        setStatus("testStatus", msg, has ? "warn" : "err");
      } catch (e) {}
    }
  } catch (e) {
    setStatus("testStatus", String(e.message || e), "err");
  }
});

load();


document.getElementById("debug").addEventListener("click", async () => {
  setStatus("testStatus", "Collecting debug info…", "hint");
  try {
    const resp = await browser.runtime.sendMessage({ type: "debug" });
    const d = resp?.debug;
    const ls = resp?.loadState;
    const has = resp?.hasDecompressionStream;
    const msg = `DecompressionStream: ${has ? "yes" : "NO"} | stage: ${d?.stage} | detail: ${d?.detail} | loaded=${ls?.loaded} loading=${ls?.loading} error=${ls?.error || ""}`;
    setStatus("testStatus", msg, has ? "warn" : "err");
  } catch (e) {
    setStatus("testStatus", String(e.message || e), "err");
  }
});
