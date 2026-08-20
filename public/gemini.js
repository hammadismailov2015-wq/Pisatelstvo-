// Бесплатный движок: Google Gemini. Ключ выдаётся без карты на aistudio.google.com/apikey
// и хранится только в браузере. Обращаемся напрямую — Google разрешает вызовы со страницы.
import { buildPrompt } from "./prompt.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_KEY = "govorilka.v1.geminiModel";
const WAY_KEY = "govorilka.v1.geminiWay";

// Мы правим чужую речь, а не сочиняем: слова автора должны доходить как сказаны,
// поэтому смягчение и фильтрацию у Google выключаем.
const SAFETY = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS",
].map((category) => ({ category, threshold: "OFF" }));

/** Имена моделей меняются, поэтому спрашиваем список у самого Google и выбираем подходящую. */
async function pickModel(key) {
  const cached = localStorage.getItem(MODEL_KEY);
  if (cached) return cached;

  const r = await fetch(`${BASE}/models`, { headers: { "x-goog-api-key": key } });
  if (!r.ok) throw errorFrom(r.status, await r.text());
  const list = (await r.json()).models || [];

  const names = list
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter((n) => n.startsWith("gemini"))
    .filter((n) => !/(embedding|aqa|imagen|veo|image|audio|tts|live|robotics)/i.test(n));

  const score = (n) => {
    const version = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || "0");
    let s = version * 10;
    if (/flash/.test(n)) s += 6;        // быстрые и щедрые по бесплатному лимиту
    if (/lite/.test(n)) s -= 3;
    if (/(preview|exp|thinking)/.test(n)) s -= 4;
    if (/latest/.test(n)) s += 1;
    return s;
  };

  const best = names.sort((a, b) => score(b) - score(a))[0];
  if (!best) throw new Error("Google не отдал ни одной подходящей модели.");
  localStorage.setItem(MODEL_KEY, best);
  return best;
}

export function forgetModel() {
  localStorage.removeItem(MODEL_KEY);
  localStorage.removeItem(WAY_KEY);
}

function errorFrom(status, raw) {
  let msg = "";
  try {
    const j = JSON.parse(raw);
    msg = j?.error?.message || j?.[0]?.error?.message || "";
  } catch { /* тело не разобралось — обойдёмся кодом ответа */ }

  if (status === 400 && /api key/i.test(msg)) return new Error("Ключ Google не подошёл — проверь его в настройках.");
  if (status === 403) return new Error("Google не пускает с этим ключом. Создай новый на aistudio.google.com/apikey");
  if (status === 429) return new Error("Бесплатный лимит на минуту исчерпан — подожди немного.");
  if (status >= 500) return new Error("Google сейчас не отвечает, попробуй ещё раз.");
  return new Error(msg || "Google вернул ошибку.");
}

/** Ответ приходит в разных формах, поэтому текст собираем аккуратно, пропуская размышления. */
function extractText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) return data.output_text.trim();

  const parts = [];
  const walk = (v, depth) => {
    if (!v || depth > 8) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v !== "object") return;
    if (v.thought === true) return;
    if (typeof v.text === "string") parts.push(v.text);
    for (const [k, val] of Object.entries(v)) if (k !== "text") walk(val, depth + 1);
  };
  walk(data, 0);
  return parts.join("").trim();
}

/** Один запрос к Google. Если параметр отключения фильтра не принят — повторяем без него. */
async function post(way, url, body, key) {
  const flag = `govorilka.v1.geminiNoSafety:${way}`;
  const withSafety = localStorage.getItem(flag) !== "1";
  const payload = withSafety ? { ...body, safetySettings: SAFETY } : body;

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(payload),
  });

  const raw = await r.text();
  if (!r.ok) {
    if (withSafety && r.status === 400 && /safety|threshold/i.test(raw)) {
      localStorage.setItem(flag, "1");
      return post(way, url, body, key);
    }
    throw errorFrom(r.status, raw);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Google ответил непонятно, попробуй ещё раз.");
  }
  return extractText(data);
}

const callInteractions = (model, system, user, key) =>
  post("interactions", `${BASE}/interactions`, { model, system_instruction: system, input: user }, key);

const callGenerateContent = (model, system, user, key) =>
  post("generate", `${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
  }, key);

/** @returns {Promise<string>} ответ модели: готовый текст или реплика соавтора */
export async function geminiAsk(payload, key) {
  const { system, user } = buildPrompt(payload);
  const model = await pickModel(key);

  // Сначала новый способ вызова, при отказе — прежний: так переживём смену API.
  // Какой сработал, запоминаем, чтобы не ходить впустую каждый раз.
  if (localStorage.getItem(WAY_KEY) !== "generate") {
    try {
      const text = await callInteractions(model, system, user, key);
      if (text) {
        localStorage.setItem(WAY_KEY, "interactions");
        return text;
      }
    } catch (e) {
      if (/лимит|ключ|не пускает/i.test(e.message)) throw e;
    }
    localStorage.setItem(WAY_KEY, "generate");
  }
  return callGenerateContent(model, system, user, key);
}
