// Persistent reminders / scheduled pings.
//
// The problem this solves: a CLI invocation (claude -p, codex exec, gemini -p)
// is a one-shot process. It has no scheduler and no future. When an LLM says
// "I'll ping you at 12:00", nothing is actually holding that promise - the
// process exits moments later and the intent evaporates. That's exactly the
// "this reminder only lives in this session" warning Huzaifa saw.
//
// So the schedule is owned by the always-on Heroku bot instead, and persisted
// the same way memory.js and contacts.js persist theirs: as a message the bot
// pins in Huzaifa's own DM and edits in place. Heroku's filesystem is wiped on
// every restart, but Discord isn't - so reminders survive deploys and dyno
// cycling, and are reloaded on boot.

const MARKER = '```json:reminders';
const TICK_MS = 30000;
const MAX_REMINDERS = 40;
const TZ = process.env.OWNER_TIMEZONE || 'Asia/Karachi';

let cache = null;        // { items: [{ id, at, text, createdAt }] }
let storeMessage = null;
let timer = null;

function encode(state) {
  return `${MARKER}\n${JSON.stringify(state)}\n\`\`\`\n_(scheduled reminders - don't delete)_`;
}

function decode(content) {
  const start = content.indexOf(MARKER);
  if (start === -1) return null;
  const jsonStart = start + MARKER.length;
  const end = content.indexOf('```', jsonStart);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(content.slice(jsonStart, end).trim());
    return { items: Array.isArray(parsed.items) ? parsed.items : [] };
  } catch (_) {
    return null;
  }
}

async function load(channel) {
  if (cache) return cache;
  cache = { items: [] };
  try {
    const pins = await channel.messages.fetchPinned();
    const found = [...pins.values()].find(
      (m) => m.author.id === channel.client.user.id && m.content.includes(MARKER),
    );
    if (found) {
      storeMessage = found;
      cache = decode(found.content) || { items: [] };
    }
  } catch (err) {
    console.log('[reminders] failed to load:', err.message);
  }
  return cache;
}

async function persist(channel) {
  try {
    // Drop anything already fired so the store can't grow forever.
    cache.items = cache.items.slice(-MAX_REMINDERS);
    if (storeMessage) {
      await storeMessage.edit(encode(cache));
    } else {
      storeMessage = await channel.send(encode(cache));
      await storeMessage.pin().catch(() => {
        console.log('[reminders] could not pin store (pin limit?) - still works this session.');
      });
    }
  } catch (err) {
    console.log('[reminders] failed to persist:', err.message);
  }
}

function formatLocal(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hour12: true,
    });
  } catch (_) {
    return iso;
  }
}

async function add(channel, isoWhen, text) {
  await load(channel);
  const when = new Date(isoWhen);
  if (Number.isNaN(when.getTime())) throw new Error(`"${isoWhen}" isn't a valid date/time.`);

  const item = {
    id: Math.random().toString(36).slice(2, 9),
    at: when.toISOString(),
    text: String(text).slice(0, 900),
    createdAt: new Date().toISOString(),
  };
  cache.items.push(item);
  cache.items.sort((a, b) => new Date(a.at) - new Date(b.at));
  await persist(channel);
  return item;
}

async function remove(channel, id) {
  await load(channel);
  const before = cache.items.length;
  cache.items = cache.items.filter((r) => r.id !== id);
  if (cache.items.length !== before) {
    await persist(channel);
    return true;
  }
  return false;
}

async function list(channel) {
  await load(channel);
  return [...cache.items].sort((a, b) => new Date(a.at) - new Date(b.at));
}

// Pull scheduling markers out of an LLM reply. Letting the model emit a
// resolved ISO timestamp is far more reliable than trying to regex-parse
// "next Tuesday afternoon" ourselves - the model already did that reasoning.
//   [[REMIND: 2026-09-16T12:00:00+05:00 | upload the assignment]]
function extractMarkers(text) {
  const found = [];
  const cleaned = String(text).replace(
    /\[\[REMIND:\s*([^|\]]+?)\s*\|\s*([\s\S]*?)\]\]/gi,
    (_m, when, msg) => {
      found.push({ when: when.trim(), text: msg.trim() });
      return '';
    },
  );
  return { cleaned: cleaned.replace(/\n{3,}/g, '\n\n').trim(), found };
}

// Fire anything due. Runs on the always-on dyno, so it doesn't matter that the
// CLI process which created the reminder exited long ago.
function start(client, ownerId) {
  if (timer) clearInterval(timer);

  timer = setInterval(async () => {
    try {
      if (!cache || !cache.items.length) return;
      const now = Date.now();
      const due = cache.items.filter((r) => new Date(r.at).getTime() <= now);
      if (!due.length) return;

      const owner = await client.users.fetch(ownerId);
      const dm = await owner.createDM();
      for (const r of due) {
        await dm.send(`Reminder: ${r.text}`).catch((e) => console.log('[reminders] send failed:', e.message));
        console.log(`[reminders] fired ${r.id}`);
      }
      cache.items = cache.items.filter((r) => !due.some((d) => d.id === r.id));
      await persist(dm);
    } catch (err) {
      console.log('[reminders] tick error:', err.message);
    }
  }, TICK_MS);
}

// Called once on boot so reminders created before a restart still fire.
async function resume(client, ownerId) {
  try {
    const owner = await client.users.fetch(ownerId);
    const dm = await owner.createDM();
    await load(dm);
    console.log(`[reminders] loaded ${cache.items.length} pending`);
    start(client, ownerId);
  } catch (err) {
    console.log('[reminders] resume failed:', err.message);
  }
}

module.exports = { add, remove, list, extractMarkers, resume, formatLocal, TZ };
