// Говорилка — обычный сервер: отдаёт статику из public/ и правит текст ключом из окружения.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixText, hasServerKey, accessCodeOk, needsAccessCode, validate, errorFor, MODEL } from "./lib/ai.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const PORT = Number(process.env.PORT || 3000);

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

async function handleFix(req, res) {
  if (!hasServerKey()) {
    return sendJson(res, 503, {
      error: "no_key",
      message: "На сервере нет ANTHROPIC_API_KEY. Можно ввести свой ключ в настройках приложения.",
    });
  }
  if (!accessCodeOk(req.headers["x-access-code"])) {
    return sendJson(res, 401, {
      error: "need_code",
      needsCode: needsAccessCode(),
      message: "Нужен код доступа — введи его в настройках приложения.",
    });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "bad_request", message: "Не смог разобрать запрос." });
  }

  const problem = validate(payload);
  if (problem) return sendJson(res, 400, { error: "bad_request", message: problem });

  try {
    const { text, warning } = await fixText(payload);
    sendJson(res, 200, warning ? { text, warning } : { text });
  } catch (e) {
    console.error("[fix]", e?.message || e);
    const { status, message } = errorFor(e);
    sendJson(res, status, { error: "api_error", message });
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
    return sendJson(res, 200, {
      ok: true,
      serverKey: hasServerKey(),
      needsCode: needsAccessCode(),
      model: MODEL,
    });
  }
  if (req.url.startsWith("/api/fix")) {
    if (req.method !== "POST") return sendJson(res, 405, { error: "method_not_allowed" });
    return handleFix(req, res);
  }
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Говорилка слушает http://localhost:${PORT}`);
  if (!hasServerKey()) {
    console.log("⚠  ANTHROPIC_API_KEY не задан — правка через ИИ будет работать только со своим ключом из настроек приложения.");
  }
  if (needsAccessCode()) console.log("🔒 Вход по коду доступа (ACCESS_CODE).");
});
