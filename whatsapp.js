// WhatsApp actions, called directly from the always-on Heroku bot.
//
// Talks to the OpenWA gateway running on Huzaifa's own Oracle Cloud VM (real
// persistent disk, unlike Heroku - see memory notes for why that split
// exists). This module needs no local PC involvement at all: Heroku calls
// out to the Oracle VM over HTTPS, same as it would call any other API.
//
// Env:
//   OPENWA_URL         e.g. https://1.2.3.4.sslip.io
//   OPENWA_API_KEY
//   OPENWA_SESSION_ID  the session UUID, not its name

const BASE = (process.env.OPENWA_URL || '').replace(/\/$/, '');
const API_KEY = process.env.OPENWA_API_KEY || '';
const SESSION_ID = process.env.OPENWA_SESSION_ID || '';

function configured() {
  return !!(BASE && API_KEY && SESSION_ID);
}

async function call(method, pathname, body) {
  if (!configured()) throw new Error('WhatsApp is not configured (OPENWA_URL/OPENWA_API_KEY/OPENWA_SESSION_ID missing).');
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'X-API-Key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON response */ }
  return { status: res.status, body: json };
}

// --- anti-ban pacing --------------------------------------------------------
// Same rationale as the local MCP version: WhatsApp flags bot-like cadence,
// so pacing is enforced here rather than trusted to whatever calls this module.
const MIN_GAP_PER_CHAT_MS = 20000;
const MIN_GAP_GLOBAL_MS = 6000;
const MAX_PER_HOUR = 40;
const lastSentPerChat = new Map();
let lastSentAny = 0;
let sentTimestamps = [];

function paceCheck(chatId) {
  const now = Date.now();
  sentTimestamps = sentTimestamps.filter((t) => now - t < 3600000);
  if (sentTimestamps.length >= MAX_PER_HOUR) return `Hourly WhatsApp send cap reached (${MAX_PER_HOUR}). Protects the account from a ban - try later.`;
  if (lastSentAny && now - lastSentAny < MIN_GAP_GLOBAL_MS) return 'Sending WhatsApp messages too fast, wait a few seconds.';
  const last = lastSentPerChat.get(chatId) || 0;
  if (last && now - last < MIN_GAP_PER_CHAT_MS) return 'Too soon to message this WhatsApp chat again, wait a bit.';
  return null;
}
function markSent(chatId) {
  const now = Date.now();
  lastSentPerChat.set(chatId, now);
  lastSentAny = now;
  sentTimestamps.push(now);
}

function toChatId(raw) {
  const s = String(raw).trim();
  if (/@(c|g)\.us$/.test(s)) return s;
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) throw new Error(`Can't read a phone number from "${raw}".`);
  return `${digits}@c.us`;
}

async function status() {
  const r = await call('GET', `/api/sessions/${SESSION_ID}`);
  return r.body || {};
}

async function sendMessage(to, text) {
  const chatId = toChatId(to);
  const clean = String(text || '').trim();
  if (!clean) throw new Error('Refusing to send an empty WhatsApp message.');
  const paced = paceCheck(chatId);
  if (paced) throw new Error(paced);

  const r = await call('POST', `/api/sessions/${SESSION_ID}/messages/send-text`, { chatId, text: clean });
  if (r.status === 201 || r.status === 200) {
    markSent(chatId);
    return { messageId: r.body && r.body.messageId };
  }
  if (r.status === 409) throw new Error('WhatsApp engine is reconnecting - retryable, try again shortly.');
  throw new Error(`WhatsApp send failed (${r.status}): ${JSON.stringify(r.body).slice(0, 300)}`);
}

async function checkNumber(number) {
  const digits = String(number).replace(/[^\d]/g, '');
  const r = await call('GET', `/api/sessions/${SESSION_ID}/contacts/check/${digits}`);
  return r.body;
}

async function listChats(limit = 20) {
  const r = await call('GET', `/api/sessions/${SESSION_ID}/chats?limit=${Math.min(limit, 50)}`);
  return r.body;
}

async function getMessages(chat, limit = 20) {
  const chatId = toChatId(chat);
  const r = await call('GET', `/api/sessions/${SESSION_ID}/chats/${encodeURIComponent(chatId)}/messages?limit=${Math.min(limit, 50)}`);
  return r.body;
}

module.exports = { configured, status, sendMessage, checkNumber, listChats, getMessages };
