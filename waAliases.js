// Manually taught name -> WhatsApp number mappings.
//
// The WhatsApp address book only knows people Huzaifa actually saved on his
// phone. Plenty of people he wants to reach (Discord friends, one-off numbers)
// aren't in it, so `wcall aden ...` would fail forever with no way to fix it.
// This store closes that gap and is checked alongside the real address book.
//
// Persisted the same way as contacts.js: a single pinned message in Huzaifa's
// own DM with the bot, edited in place. Heroku's filesystem is wiped on every
// restart, so a file on disk would not survive; a Discord message does.

const MARKER = '```json:wa-aliases';

function encode(aliases) {
  return `${MARKER}\n${JSON.stringify(aliases, null, 2)}\n\`\`\`\n_(WhatsApp number book - don't delete this message)_`;
}

function decode(content) {
  const start = content.indexOf(MARKER);
  if (start === -1) return null;
  const jsonStart = start + MARKER.length;
  const end = content.indexOf('```', jsonStart);
  if (end === -1) return null;
  try {
    return JSON.parse(content.slice(jsonStart, end).trim());
  } catch (_) {
    return null;
  }
}

let cache = null; // { [lowercased name]: { phone, name } }
let storeMessage = null;

async function load(ownerDmChannel) {
  if (cache) return cache;
  cache = {};
  try {
    const pins = await ownerDmChannel.messages.fetchPinned();
    const found = [...pins.values()].find(
      (m) => m.author.id === ownerDmChannel.client.user.id && m.content.includes(MARKER),
    );
    if (found) {
      storeMessage = found;
      cache = decode(found.content) || {};
    }
  } catch (err) {
    console.log('[waAliases] failed to load pinned store:', err.message);
  }
  return cache;
}

async function persist(ownerDmChannel) {
  try {
    if (storeMessage) {
      await storeMessage.edit(encode(cache));
    } else {
      storeMessage = await ownerDmChannel.send(encode(cache));
      await storeMessage.pin().catch(() => {
        console.log('[waAliases] could not pin the number book (DM pin limit) - still works this session.');
      });
    }
  } catch (err) {
    console.log('[waAliases] failed to persist:', err.message);
  }
}

/** Teach (or correct) a name -> number mapping. */
async function save(ownerDmChannel, name, phone) {
  await load(ownerDmChannel);
  const digits = String(phone).replace(/[^\d]/g, '');
  const clean = String(name).trim();
  if (!clean || digits.length < 7) throw new Error('Need both a name and a real phone number.');
  cache[clean.toLowerCase()] = { phone: digits, name: clean };
  await persist(ownerDmChannel);
  return { phone: digits, name: clean };
}

async function remove(ownerDmChannel, name) {
  await load(ownerDmChannel);
  const key = String(name).trim().toLowerCase();
  if (!cache[key]) return false;
  delete cache[key];
  await persist(ownerDmChannel);
  return true;
}

async function list(ownerDmChannel) {
  await load(ownerDmChannel);
  return Object.values(cache);
}

/** Same scoring shape as waContacts so results can be ranked together. */
function score(query, name) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(query);
  const n = norm(name);
  if (!q || !n) return 0;
  if (n === q) return 100;
  if (n.startsWith(q)) return 85;
  const words = n.split(' ');
  if (words.some((w) => w === q)) return 80;
  if (words.some((w) => w.startsWith(q))) return 70;
  if (n.includes(q)) return 55;
  const tokens = q.split(' ').filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => n.includes(t))) return 50;
  return 0;
}

/** Matches from the taught aliases only. */
async function search(ownerDmChannel, query) {
  await load(ownerDmChannel);
  return Object.values(cache)
    .map((c) => ({ ...c, _score: score(query, c.name), _alias: true }))
    .filter((c) => c._score > 0)
    .sort((a, b) => b._score - a._score);
}

module.exports = { load, save, remove, list, search, score };
