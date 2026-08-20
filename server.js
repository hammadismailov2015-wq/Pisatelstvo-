// Говорилка — сервер: отдаёт статику из public/ и чинит распознанный текст через Claude API.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { buildPrompt, MODEL, MAX_TOKENS } from "./public/prompt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 3000);
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const client = HAS_KEY ? new Anthropic() : null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "cache-control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), { "content-type": "application/json; charset=utf-8" });
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function textOf(message) {
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

async function fix(payload) {
  const { system, user } = buildPrompt(payload);
  const message = await client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // Опус 5 сам решает, сколько думать; для правки речи хватает низкого усилия — так быстрее.
    output_config: { effort: "low" },
    // Если запрос вдруг отклонён классификатором — сервер сам переключится на запасную модель.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
  });

  if (message.stop_reason === "refusal") {
    const err = new Error("refusal");
    err.code = "refusal";
    throw err;
  }
  return textOf(message);
}

async function handleFix(req, res) {
  if (!client) {
    return sendJson(res, 503, {
      error: "no_key",
      message: "На сервере нет ключа ANTHROPIC_API_KEY. Можно ввести свой ключ в настройках приложения.",
    });
  }
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad_request", message: "Не смог разобрать запрос." });
  }
  if (!payload || typeof payload.raw !== "string" || !payload.raw.trim()) {
    return sendJson(res, 400, { error: "empty", message: "Пустой текст." });
  }

  try {
    const text = await fix(payload);
    sendJson(res, 200, { text });
  } catch (e) {
    if (e?.code === "refusal") {
      return sendJson(res, 200, { text: payload.raw, warning: "Модель отказалась править этот фрагмент — оставил как есть." });
    }
    const status = e?.status;
    const map = {
      401: "Ключ не подошёл. Проверь ANTHROPIC_API_KEY.",
      429: "Слишком много запросов подряд, попробуй через несколько секунд.",
      529: "Сервис перегружен, попробуй ещё раз.",
    };
    console.error("[fix]", e?.message || e);
    sendJson(res, status && status < 500 ? status : 502, {
      error: "api_error",
      message: map[status] || "Не получилось связаться с ИИ. Текст сохранён как есть.",
    });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, "Forbidden");

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "Не найдено");
    const type = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    send(res, 200, data, { "content-type": type });
  });
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api/health")) {
    return sendJson(res, 200, { ok: true, serverKey: HAS_KEY, model: MODEL });
  }
  if (req.url.startsWith("/api/fix")) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    return handleFix(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Говорилка слушает http://localhost:${PORT}`);
  if (!HAS_KEY) {
    console.log("⚠  ANTHROPIC_API_KEY не задан — правка через ИИ будет работать только со своим ключом из настроек приложения.");
  }
});
