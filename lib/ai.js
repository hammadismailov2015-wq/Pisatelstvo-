// Общая логика правки текста: используется и обычным сервером (server.js),
// и бессерверными функциями хостинга (api/*.js).
import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, MODEL, MAX_TOKENS } from "../public/prompt.js";

export { MODEL };

let client = null;

export function hasServerKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function needsAccessCode() {
  return Boolean(process.env.ACCESS_CODE);
}

/** Код доступа защищает чужой расход ключа. Не задан — открыто для всех. */
export function accessCodeOk(given) {
  const code = process.env.ACCESS_CODE;
  if (!code) return true;
  return typeof given === "string" && given === code;
}

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export function validate(payload) {
  if (!payload || typeof payload.raw !== "string") return "Пустой текст.";
  const coauthor = payload.mode === "coauthor";
  const request = String(payload.request || "").trim();
  if (!payload.raw.trim() && !(coauthor && request)) return "Пустой текст.";
  if (payload.raw.length > (coauthor ? 60000 : 20000)) return "Слишком длинный текст.";
  return null;
}

/** @returns {Promise<{text: string, warning?: string}>} */
export async function fixText(payload) {
  const { system, user } = buildPrompt(payload);
  const message = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Правка речи — не задача на размышления, низкое усилие даёт ответ быстрее.
    output_config: { effort: "low" },
    // Если запрос отклонён классификатором — ответит запасная модель.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });

  if (message.stop_reason === "refusal") {
    return payload.mode === "coauthor"
      ? { text: "", warning: "Модель отказалась отвечать на этот запрос." }
      : { text: payload.raw, warning: "Модель отказалась править этот фрагмент — оставил как есть." };
  }

  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { text: text || payload.raw };
}

export function errorFor(e) {
  const status = e?.status;
  const known = {
    401: "Ключ на сервере не подошёл. Проверь ANTHROPIC_API_KEY в настройках хостинга.",
    402: "На счёте Anthropic закончились деньги — пополни баланс в консоли.",
    429: "Слишком много запросов подряд, попробуй через несколько секунд.",
    529: "Сервис перегружен, попробуй ещё раз.",
  };
  return {
    status: status && status < 500 ? status : 502,
    message: known[status] || "Не получилось связаться с ИИ. Текст сохранён как есть.",
  };
}
