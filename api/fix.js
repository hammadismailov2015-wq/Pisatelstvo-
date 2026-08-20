// Бессерверная функция: правит распознанный текст ключом, который лежит на сервере.
import { fixText, hasServerKey, accessCodeOk, needsAccessCode, validate, errorFor } from "../lib/ai.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("cache-control", "no-store");

  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  if (!hasServerKey()) {
    return res.status(503).json({
      error: "no_key",
      message: "На сервере не задан ANTHROPIC_API_KEY. Добавь его в переменные окружения хостинга.",
    });
  }

  if (!accessCodeOk(req.headers["x-access-code"])) {
    return res.status(401).json({
      error: "need_code",
      needsCode: needsAccessCode(),
      message: "Нужен код доступа — введи его в настройках приложения.",
    });
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }

  const problem = validate(payload);
  if (problem) return res.status(400).json({ error: "bad_request", message: problem });

  try {
    const { text, warning } = await fixText(payload);
    res.status(200).json(warning ? { text, warning } : { text });
  } catch (e) {
    console.error("[fix]", e?.message || e);
    const { status, message } = errorFor(e);
    res.status(status).json({ error: "api_error", message });
  }
}
