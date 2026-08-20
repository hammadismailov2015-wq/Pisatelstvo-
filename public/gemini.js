// Бесплатный движок: Google Gemini. Ключ выдаётся без карты на aistudio.google.com/apikey
// и хранится только в браузере. Обращаемся напрямую — Google разрешает вызовы со страницы.
import { buildPrompt } from "./prompt.js";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const MODEL_KEY = "govorilka.v1.geminiModel";

/** Имена моделей меняются, поэтому спрашиваем список у самого Google и выбираем подходящую. */
async function pickModel(key) {
  const cached = localStorage.getItem(MODEL_KEY);
  if (cached) return cached;

  const r = await fetch(`${BASE}/models`, { headers: { "x-goog-api-key": key } });
  if (!r.ok) throw await toError(r, "Не удалось получить список моделей Google.");
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
}

async function toError(r, fallback) {
  const j = await r.json().catch(() => null);
  const msg = j?.error?.message || j?.[0]?.error?.message || "";
  if (r.status === 400 && /api key/i.test(msg)) return new Error("Ключ Google не подошёл — проверь его в настройках.");
  if (r.status === 403) return new Error("Google не пускает с этим ключом. Создай новый на aistudio.google.com/apikey");
  if (r.status === 429) return new Error("Бесплатный лимит на минуту исчерпан — подожди немного.");
  if (r.status >= 500) return new Error("Google сейчас не отвечает, попробуй ещё раз.");
  return new Error(msg || fallback);
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

async function callInteractions(model, system, user, key) {
  const r = await fetch(`${BASE}/interactions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ model, system_instruction: system, input: user }),
  });
  if (!r.ok) throw await toError(r, "Google вернул ошибку.");
  return extractText(await r.json());
}

async function callGenerateContent(model, system, user, key) {
  const r = await fetch(`${BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
    }),
  });
  if (!r.ok) throw await toError(r, "Google вернул ошибку.");
  return extractText(await r.json());
}

/** @returns {Promise<string>} готовый текст */
export async function geminiFix(payload, key) {
  const { system, user } = buildPrompt(payload);
  const model = await pickModel(key);

  // Сначала новый способ вызова, при отказе — прежний: так переживём смену API.
  try {
    const text = await callInteractions(model, system, user, key);
    if (text) return text;
  } catch (e) {
    if (/лимит|ключ|не пускает/i.test(e.message)) throw e;
  }
  return callGenerateContent(model, system, user, key);
}
