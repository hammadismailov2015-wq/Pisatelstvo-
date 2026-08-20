// Память твоих исправлений: поправил слово руками — дальше приложение правит его само.
// Работает без интернета и без ключа, всё хранится только в этом браузере.
const STORE = "govorilka.v1.dict";
const LIMIT = 400;

const clean = (w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const key = (w) => clean(w).toLowerCase();

export function loadDict() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch {
    return {};
  }
}

function saveDict(dict) {
  let entries = Object.entries(dict);
  if (entries.length > LIMIT) {
    entries.sort((a, b) => (b[1].hits || 0) - (a[1].hits || 0));
    dict = Object.fromEntries(entries.slice(0, LIMIT));
  }
  localStorage.setItem(STORE, JSON.stringify(dict));
}

export function dictSize() {
  return Object.keys(loadDict()).length;
}

export function clearDict() {
  localStorage.removeItem(STORE);
}

/** Запомнить замену: было → стало. */
export function remember(from, to) {
  const a = key(from);
  const b = clean(to);
  if (!a || !b || a === b.toLowerCase()) return false;
  if (a.length < 2 || b.length > 40) return false;
  // Человек просто дописывал слово («прив» → «привет») — это не поправка.
  if (b.toLowerCase().startsWith(a) && b.length - a.length >= 2) return false;

  const dict = loadDict();
  const prev = dict[a];
  dict[a] = { to: b, hits: (prev?.to === b ? prev.hits || 1 : 0) + 1 };
  saveDict(dict);
  return true;
}

/** Сравниваем текст до и после ручной правки и вылавливаем заменённые слова. */
export function learnFromEdit(before, after) {
  const a = before.split(/\s+/).filter(Boolean);
  const b = after.split(/\s+/).filter(Boolean);
  if (!a.length || !b.length || Math.abs(a.length - b.length) > 2) return 0;

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const was = a.slice(head, a.length - tail);
  const now = b.slice(head, b.length - tail);
  // Учимся только на точечных заменах слов — переписанные куски не в счёт.
  if (!was.length || was.length !== now.length || was.length > 3) return 0;

  let learned = 0;
  for (let i = 0; i < was.length; i++) if (remember(was[i], now[i])) learned++;
  return learned;
}

/** Применить запомненные поправки к новому куску текста. */
export function applyDict(text) {
  const dict = loadDict();
  if (!text || !Object.keys(dict).length) return text;

  return text.replace(/[\p{L}\p{N}][\p{L}\p{N}-]*/gu, (word) => {
    const hit = dict[word.toLowerCase()];
    if (!hit) return word;
    return /^\p{Lu}/u.test(word) ? hit.to.charAt(0).toUpperCase() + hit.to.slice(1) : hit.to;
  });
}
