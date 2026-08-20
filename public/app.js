import { buildPrompt, MODEL, MAX_TOKENS, STYLES } from "./prompt.js";

const $ = (id) => document.getElementById(id);
const el = {
  text: $("text"), pending: $("pending"), live: $("live"), hint: $("hint"),
  mic: $("micBtn"), micLabel: $("micLabel"), dot: $("statusDot"),
  style: $("style"), settings: $("settings"), settingsBtn: $("settingsBtn"),
  lang: $("lang"), instruction: $("instruction"), autoFix: $("autoFix"),
  apiKey: $("apiKey"), keyStatus: $("keyStatus"), saveSettings: $("saveSettings"),
  accessCode: $("accessCode"), codeField: $("codeField"), keyBlock: $("keyBlock"),
  copy: $("copyBtn"), share: $("shareBtn"), polish: $("polishBtn"),
  undo: $("undoBtn"), clear: $("clearBtn"),
};

// ---------- настройки и сохранение ----------

const STORE = "govorilka.v1";
const settings = Object.assign(
  { lang: "ru-RU", style: "auto", instruction: "", autoFix: true, apiKey: "", accessCode: "" },
  JSON.parse(localStorage.getItem(STORE + ".settings") || "{}")
);

const saveSettings = () => localStorage.setItem(STORE + ".settings", JSON.stringify(settings));
const saveText = () => localStorage.setItem(STORE + ".text", el.text.value);

el.text.value = localStorage.getItem(STORE + ".text") || "";

for (const [value, { label }] of Object.entries(STYLES)) {
  el.style.append(new Option(label, value));
}
el.style.value = settings.style;
el.lang.value = settings.lang;
el.instruction.value = settings.instruction;
el.autoFix.checked = settings.autoFix;
el.apiKey.value = settings.apiKey;
el.accessCode.value = settings.accessCode;

// ---------- связь с ИИ ----------

let serverHasKey = false;
let serverReachable = false;
let serverNeedsCode = false;

async function probeServer() {
  try {
    const r = await fetch("api/health", { cache: "no-store" });
    if (!r.ok) throw new Error();
    const j = await r.json();
    serverReachable = true;
    serverHasKey = Boolean(j.serverKey);
    serverNeedsCode = Boolean(j.needsCode);
  } catch {
    serverReachable = false;
    serverHasKey = false;
    serverNeedsCode = false;
  }
  refreshKeyStatus();
  maybeOnboard();
}

function aiReady() {
  return serverHasKey || Boolean(settings.apiKey);
}

// Сервер с ключом просит только код доступа (если он вообще настроен).
function codeMissing() {
  return serverHasKey && serverNeedsCode && !settings.accessCode;
}

// Первый заход, когда чего-то не хватает: сразу показываем настройки.
function maybeOnboard() {
  if ((aiReady() && !codeMissing()) || localStorage.getItem(STORE + ".onboarded")) return;
  localStorage.setItem(STORE + ".onboarded", "1");
  el.settings.showModal();
}

function refreshKeyStatus() {
  el.codeField.hidden = !serverNeedsCode;
  el.keyBlock.hidden = serverHasKey;

  if (serverHasKey) {
    el.keyStatus.textContent = "Ключ есть на сервере — всё работает, свой вводить не нужно.";
    if (codeMissing()) say("Нужен код доступа — впиши его в настройках (⚙).", true);
    return;
  }
  if (settings.apiKey) {
    el.keyStatus.textContent = "Работаем с твоим ключом из этого браузера.";
  } else {
    el.keyStatus.textContent = "Ключа нет: текст будет причёсываться простыми правилами, без ИИ.";
  }
  if (!aiReady()) {
    say("Без ключа ИИ не подключён — правлю только базовыми правилами. Ключ вводится в настройках (⚙).");
  }
}

async function askAI(payload) {
  const body = { ...payload, style: settings.style, instruction: settings.instruction };

  if (serverHasKey) {
    const headers = { "content-type": "application/json" };
    if (settings.accessCode) headers["x-access-code"] = settings.accessCode;
    const r = await fetch("api/fix", { method: "POST", headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.error === "need_code") {
      serverNeedsCode = true;
      refreshKeyStatus();
      el.settings.showModal();
      throw new Error("Нужен код доступа — впиши его в настройках (⚙).");
    }
    if (!r.ok) throw new Error(j.message || "Сервер не ответил.");
    if (j.warning) say(j.warning);
    return j.text;
  }

  const { system, user } = buildPrompt(body);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      output_config: { effort: "low" },
      fallbacks: "default",
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || "";
    if (r.status === 401) throw new Error("Ключ не подошёл — проверь его в настройках.");
    if (r.status === 429) throw new Error("Слишком часто, подожди пару секунд.");
    throw new Error(msg || `Ошибка ИИ (${r.status}).`);
  }
  if (j.stop_reason === "refusal") {
    say("Модель отказалась править этот фрагмент — оставил как есть.");
    return payload.raw;
  }
  return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

// ---------- запасная правка без ИИ ----------

// Порядок важен: длинные фразы раньше коротких («точка с запятой» до «точка»).
const SPOKEN = [
  ["новый абзац", "\n\n"], ["с новой строки", "\n"], ["новая строка", "\n"],
  ["точка с запятой", ";"], ["вопросительный знак", "?"], ["восклицательный знак", "!"],
  ["двоеточие", ":"], ["запятая", ","], ["точка", "."], ["тире", " —"],
];
const FILLERS = ["э", "ээ", "эээ", "э-э", "ну", "как бы", "это самое", "типа", "короче"];

// \b в JS не видит границ кириллических слов, поэтому границы задаём сами.
function wordRe(word) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])(?:${word})(?=[^\\p{L}\\p{N}]|$)`, "giu");
}

function localFix(raw) {
  let s = raw;
  for (let pass = 0; pass < 2; pass++) {
    for (const f of FILLERS) s = s.replace(wordRe(f), "$1");
  }
  for (const [word, mark] of SPOKEN) s = s.replace(wordRe(word), "$1" + mark);
  s = s
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/([,.!?;:])(?=[^\s,.!?;:\n])/g, "$1 ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/(\p{L}|\p{N})\n/gu, "$1.\n")
    .trim();
  if (s && !/[.!?…\n]$/.test(s)) s += ".";
  return s.replace(/(^|[.!?…]\s+|\n\s*)(\p{Ll})/gu, (m, p, c) => p + c.toUpperCase());
}

// ---------- текст, история, склейка ----------

const undoStack = [];

function pushUndo() {
  undoStack.push(el.text.value);
  if (undoStack.length > 30) undoStack.shift();
  el.undo.disabled = false;
}

function appendText(chunk) {
  const piece = chunk.trim();
  if (!piece) return;
  pushUndo();
  const cur = el.text.value;
  const sep = !cur || /\n$/.test(cur) ? "" : " ";
  el.text.value = (cur + sep + piece).replace(/[ \t]+\n/g, "\n");
  saveText();
  el.text.scrollTop = el.text.scrollHeight;
}

const tailContext = () => el.text.value.slice(-700);

// ---------- очередь правки ----------

let queue = Promise.resolve();
let inFlight = 0;

function enqueue(raw) {
  const useAI = settings.autoFix && aiReady();
  if (!useAI) {
    appendText(localFix(raw));
    return;
  }
  inFlight++;
  setStatus();
  queue = queue.then(async () => {
    try {
      const fixed = await askAI({ raw, context: tailContext(), mode: "chunk" });
      appendText(fixed || localFix(raw));
      say("");
    } catch (e) {
      appendText(localFix(raw));
      say(e.message || "ИИ не ответил — записал как расслышал.", true);
    } finally {
      inFlight--;
      updatePending();
      setStatus();
    }
  });
  updatePending();
}

// ---------- распознавание речи ----------

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recog = null;
let listening = false;
let rawBuffer = "";
let flushTimer = null;
let wakeLock = null;

if (!SR) {
  el.mic.disabled = true;
  el.micLabel.textContent = "Браузер не умеет распознавать речь";
  say("Голосовой ввод работает в Chrome (Android, компьютер) и в Safari на iOS. Открой приложение там — или пиши руками, кнопка «Причесать всё» всё равно работает.", true);
}

function flushBuffer() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const raw = rawBuffer.trim();
  rawBuffer = "";
  if (raw) enqueue(raw);
  updatePending();
}

function scheduleFlush(delay = 1100) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushBuffer, delay);
}

function createRecognition() {
  const r = new SR();
  r.lang = settings.lang;
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const t = res[0].transcript;
      if (res.isFinal) {
        rawBuffer += (rawBuffer ? " " : "") + t.trim();
      } else {
        interim += t;
      }
    }
    el.live.textContent = interim.trim();
    updatePending();
    // Длинную реплику отправляем, не дожидаясь паузы, чтобы текст не отставал.
    if (rawBuffer.length > 320) flushBuffer();
    else if (rawBuffer) scheduleFlush(interim ? 1800 : 900);
  };

  r.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      stopListening();
      say("Браузер не дал доступ к микрофону. Разреши его в настройках сайта и попробуй снова.", true);
      return;
    }
    if (e.error === "network") say("Распознавание потеряло сеть, пробую снова…", true);
  };

  r.onend = () => {
    // Мобильный Chrome обрывает распознавание после паузы — просто поднимаем заново.
    if (listening) {
      try { r.start(); } catch { setTimeout(() => { if (listening) try { r.start(); } catch {} }, 300); }
    }
  };
  return r;
}

async function startListening() {
  if (!SR || listening) return;
  recog = createRecognition();
  listening = true;
  try {
    recog.start();
  } catch {
    listening = false;
    say("Не удалось запустить микрофон, попробуй ещё раз.", true);
    return;
  }
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* не критично */ }
  setStatus();
  el.micLabel.textContent = "Слушаю… нажми, чтобы остановить";
  el.mic.classList.add("on");
  say(aiReady() ? "" : "Работаю без ИИ: знаки ставлю простыми правилами.");
}

function stopListening() {
  listening = false;
  try { recog?.stop(); } catch { /* уже остановлен */ }
  recog = null;
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
  el.live.textContent = "";
  el.mic.classList.remove("on");
  el.micLabel.textContent = "Нажми и говори";
  flushBuffer();
  setStatus();
}

// ---------- индикаторы ----------

function say(msg, isError = false) {
  el.hint.textContent = msg;
  el.hint.classList.toggle("error", Boolean(isError) && Boolean(msg));
}

function setStatus() {
  el.dot.className = "dot" + (listening ? " listening" : inFlight ? " working" : "");
  el.micLabel.textContent = listening
    ? (inFlight ? "Слушаю, ИИ причёсывает…" : "Слушаю… нажми, чтобы остановить")
    : (inFlight ? "ИИ дописывает…" : "Нажми и говори");
}

function updatePending() {
  const parts = [rawBuffer.trim(), el.live.textContent.trim()].filter(Boolean);
  const waiting = inFlight > 0;
  const txt = parts.join(" ");
  el.pending.hidden = !txt && !waiting;
  el.pending.textContent = txt || (waiting ? "…" : "");
}

// ---------- кнопки ----------

el.mic.addEventListener("click", () => (listening ? stopListening() : startListening()));

el.text.addEventListener("input", saveText);

el.style.addEventListener("change", () => {
  settings.style = el.style.value;
  saveSettings();
});

el.copy.addEventListener("click", async () => {
  const text = el.text.value;
  if (!text) return say("Пока нечего копировать.");
  try {
    await navigator.clipboard.writeText(text);
    say("Скопировано.");
  } catch {
    el.text.select();
    document.execCommand?.("copy");
    say("Скопировано.");
  }
});

if (navigator.share) {
  el.share.hidden = false;
  el.share.addEventListener("click", () => {
    if (!el.text.value) return say("Пока нечего отправлять.");
    navigator.share({ text: el.text.value }).catch(() => {});
  });
}

el.polish.addEventListener("click", async () => {
  const text = el.text.value.trim();
  if (!text) return say("Сначала наговори текст.");
  if (!aiReady()) return say("Для этого нужен ключ — введи его в настройках (⚙).", true);
  el.polish.disabled = true;
  inFlight++;
  setStatus();
  say("Причёсываю целиком…");
  try {
    const fixed = await askAI({ raw: text, mode: "full" });
    if (fixed) {
      pushUndo();
      el.text.value = fixed;
      saveText();
      say("Готово.");
    }
  } catch (e) {
    say(e.message || "Не получилось причесать текст.", true);
  } finally {
    inFlight--;
    el.polish.disabled = false;
    setStatus();
  }
});

el.undo.addEventListener("click", () => {
  const prev = undoStack.pop();
  if (prev === undefined) return;
  el.text.value = prev;
  saveText();
  el.undo.disabled = undoStack.length === 0;
  say("Вернул как было.");
});

el.clear.addEventListener("click", () => {
  if (!el.text.value) return;
  if (!confirm("Очистить весь текст?")) return;
  pushUndo();
  el.text.value = "";
  saveText();
  say("Пусто. Отменить можно кнопкой «Отменить».");
});

el.settingsBtn.addEventListener("click", () => {
  refreshKeyStatus();
  el.settings.showModal();
});

el.settings.addEventListener("close", () => {
  if (el.settings.returnValue !== "save") return;
  const wasListening = listening;
  settings.lang = el.lang.value;
  settings.instruction = el.instruction.value.trim();
  settings.autoFix = el.autoFix.checked;
  settings.apiKey = el.apiKey.value.trim();
  settings.accessCode = el.accessCode.value.trim();
  saveSettings();
  refreshKeyStatus();
  if (wasListening) { stopListening(); startListening(); }
  say("Настройки сохранены.");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && listening) flushBuffer();
});

window.addEventListener("beforeunload", saveText);

probeServer();
setStatus();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
