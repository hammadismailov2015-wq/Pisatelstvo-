// Бессерверная функция: сообщает приложению, есть ли ключ на сервере.
import { hasServerKey, needsAccessCode, MODEL } from "../lib/ai.js";

export default function handler(req, res) {
  res.setHeader("cache-control", "no-store");
  res.status(200).json({ ok: true, serverKey: hasServerKey(), needsCode: needsAccessCode(), model: MODEL });
}
