// Resolves a spoken/typed name ("aden", "abdul ahad") to a real WhatsApp
// phone number, using Huzaifa's actual saved WhatsApp address book.
//
// Data quirks this works around (measured against the live account, 1000 raw
// entries -> 191 usable contacts):
//   * Every contact appears twice: once with its real phone number and once
//     with a "lid" style internal id. The `number` field is unreliable for
//     exactly this reason - on all 191 entries it disagreed with the id.
//     So the phone is derived from the `id` prefix (`923...@c.us`), never
//     from `number`.
//   * Group/unknown entries use `@lid` ids and have no name - dropped.
//   * Only `isMyContact` entries are considered, so we never surface random
//     strangers from group chats as call targets.

const BASE = (process.env.OPENWA_URL || '').replace(/\/$/, '');
const API_KEY = process.env.OPENWA_API_KEY || '';
const SESSION_ID = process.env.OPENWA_SESSION_ID || '';

const CACHE_MS = 5 * 60 * 1000;
let cache = null;
let cachedAt = 0;

function configured() {
  return !!(BASE && API_KEY && SESSION_ID);
}

/** All usable saved contacts: [{ phone, name }], deduped by phone. */
async function all({ force = false } = {}) {
  if (!configured()) throw new Error('WhatsApp is not configured.');
  if (!force && cache && Date.now() - cachedAt < CACHE_MS) return cache;

  const res = await fetch(`${BASE}/api/sessions/${SESSION_ID}/contacts`, {
    headers: { 'X-API-Key': API_KEY },
  });
  if (!res.ok) throw new Error(`Couldn't read WhatsApp contacts (${res.status}).`);
  const raw = await res.json();

  const byPhone = new Map();
  for (const c of Array.isArray(raw) ? raw : []) {
    if (!c || !c.isMyContact || !c.name) continue;
    const id = String(c.id || '');
    if (!id.endsWith('@c.us')) continue;
    const phone = id.split('@')[0];
    if (!/^\d{7,15}$/.test(phone)) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, { phone, name: String(c.name).trim() });
  }

  cache = [...byPhone.values()];
  cachedAt = Date.now();
  return cache;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * How well `name` matches `query`. 0 means "not a match at all".
 * Ordered so an exact name always beats a partial, and a partial that starts
 * a word ("ahad" in "Abdul Ahad") beats a mid-word substring.
 */
function score(query, name) {
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 85;

  const words = n.split(' ');
  if (words.some((w) => w === q)) return 80;
  if (words.some((w) => w.startsWith(q))) return 70;
  if (n.includes(q)) return 55;

  // every token of the query appears somewhere ("ahad abdul" -> "Abdul Ahad")
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => n.includes(t))) return 50;
  return 0;
}

/** Best matches for a name, strongest first. Capped for Discord's 25-option limit. */
async function search(query, { limit = 25 } = {}) {
  const contacts = await all();
  return contacts
    .map((c) => ({ ...c, _score: score(query, c.name) }))
    .filter((c) => c._score > 0)
    .sort((a, b) => b._score - a._score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** +92 355 641 8183 - easier to eyeball than a raw digit run. */
function formatPhone(phone) {
  const d = String(phone);
  if (d.length === 12 && d.startsWith('92')) {
    return `+92 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  }
  return `+${d}`;
}

module.exports = { configured, all, search, score, formatPhone };
