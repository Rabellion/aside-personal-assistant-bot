// Cross-provider conversation memory: recent turns + durable "remembered
// facts", shared no matter which model (Claude/ChatGPT/Gemini/local agent) is
// currently active, so switching /model doesn't feel like talking to a
// stranger with amnesia.
//
// Persisted the same way contacts.js persists its store: as a single message
// the bot posts and pins in Huzaifa's own DM, edited in place. Heroku's
// filesystem is wiped on every restart/deploy, but Discord isn't - so this
// survives redeploys, unlike a plain in-process array.

const MARKER = '```json:memory';
// Keep the encoded blob comfortably under Discord's 2000-char message cap.
const MAX_HISTORY_CHARS = 1400;
const MAX_FACTS = 30;
const MAX_TURNS_RETURNED = 12;

function emptyState() {
  return { history: [], facts: [] };
}

function encode(state) {
  return `${MARKER}\n${JSON.stringify(state)}\n\`\`\`\n_(assistant memory - conversation history + remembered facts. don't delete)_`;
}

function decode(content) {
  const start = content.indexOf(MARKER);
  if (start === -1) return null;
  const jsonStart = start + MARKER.length;
  const end = content.indexOf('```', jsonStart);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(content.slice(jsonStart, end).trim());
    return { history: parsed.history || [], facts: parsed.facts || [] };
  } catch (_) {
    return null;
  }
}

let cache = null;
let storeMessage = null;

async function load(ownerDmChannel) {
  if (cache) return cache;
  cache = emptyState();
  try {
    const pins = await ownerDmChannel.messages.fetchPinned();
    const found = [...pins.values()].find((m) => m.author.id === ownerDmChannel.client.user.id && m.content.includes(MARKER));
    if (found) {
      storeMessage = found;
      cache = decode(found.content) || emptyState();
    }
  } catch (err) {
    console.log('[memory] failed to load pinned store:', err.message);
  }
  return cache;
}

function trimToBudget() {
  // Drop oldest turns first until the encoded state fits the char budget.
  while (cache.history.length > 2 && encode(cache).length > MAX_HISTORY_CHARS + 300) {
    cache.history.shift();
  }
}

async function persist(ownerDmChannel) {
  trimToBudget();
  try {
    if (storeMessage) {
      await storeMessage.edit(encode(cache));
    } else {
      storeMessage = await ownerDmChannel.send(encode(cache));
      await storeMessage.pin().catch(() => {
        console.log('[memory] could not pin memory store (pin limit or missing perms) - it will still work this session.');
      });
    }
  } catch (err) {
    console.log('[memory] failed to persist:', err.message);
  }
}

async function appendTurn(ownerDmChannel, role, text) {
  await load(ownerDmChannel);
  cache.history.push({ role, text: String(text).slice(0, 600) });
  await persist(ownerDmChannel);
}

async function addFact(ownerDmChannel, fact) {
  await load(ownerDmChannel);
  const clean = fact.trim();
  if (!clean) return;
  if (!cache.facts.some((f) => f.toLowerCase() === clean.toLowerCase())) {
    cache.facts.push(clean);
    if (cache.facts.length > MAX_FACTS) cache.facts.shift();
  }
  await persist(ownerDmChannel);
}

// Builds the text block to prepend to a prompt so any provider gets the same
// continuity. Kept plain-text (not JSON) because that's what an LLM reads best.
function buildContext() {
  if (!cache) return '';
  const parts = [];
  if (cache.facts.length) {
    parts.push(`Things you already know about Huzaifa:\n- ${cache.facts.join('\n- ')}`);
  }
  const recent = cache.history.slice(-MAX_TURNS_RETURNED);
  if (recent.length) {
    parts.push(
      `Recent conversation (most recent last):\n${recent.map((h) => `${h.role === 'user' ? 'Huzaifa' : 'You'}: ${h.text}`).join('\n')}`,
    );
  }
  if (!parts.length) return '';
  return `${parts.join('\n\n')}\n\nContinue the conversation naturally. Don't repeat this context back to Huzaifa.\n\n`;
}

module.exports = { load, appendTurn, addFact, buildContext };
