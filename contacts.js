// Persistent nickname -> Discord user mapping, so Huzaifa can say "tell morph
// ..." instead of "/dm @Morph ...".
//
// Heroku's filesystem is ephemeral (wiped on every restart), so this can't be
// a plain JSON file on disk. Instead it's stored as a single message the bot
// posts and pins in Huzaifa's own DM with it, and edits in place whenever a
// new contact is learned. That message is the durable store - no database,
// no extra Heroku add-on cost.

const MARKER = '```json:contacts';

function encode(contacts) {
  return `${MARKER}\n${JSON.stringify(contacts, null, 2)}\n\`\`\`\n_(this message is the assistant's contact book - don't delete it)_`;
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

let cache = null; // { [alias]: { userId, username } }
let storeMessage = null; // the pinned message we read/write

async function load(ownerDmChannel) {
  if (cache) return cache;
  cache = {};
  try {
    const pins = await ownerDmChannel.messages.fetchPinned();
    const found = [...pins.values()].find((m) => m.author.id === ownerDmChannel.client.user.id && m.content.includes(MARKER));
    if (found) {
      storeMessage = found;
      cache = decode(found.content) || {};
    }
  } catch (err) {
    console.log('[contacts] failed to load pinned store:', err.message);
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
        console.log('[contacts] could not pin contact store (DM pin limit is 50, or missing perms) - it will still work this session.');
      });
    }
  } catch (err) {
    console.log('[contacts] failed to persist:', err.message);
  }
}

async function learn(ownerDmChannel, alias, userId, username) {
  await load(ownerDmChannel);
  cache[alias.toLowerCase()] = { userId, username };
  await persist(ownerDmChannel);
}

function findByAlias(alias) {
  if (!cache) return null;
  const key = alias.toLowerCase().trim();
  if (cache[key]) return cache[key];
  // loose match: alias is a substring of, or contains, a saved alias
  const hit = Object.entries(cache).find(([k]) => k.includes(key) || key.includes(k));
  return hit ? hit[1] : null;
}

module.exports = { load, learn, findByAlias };
