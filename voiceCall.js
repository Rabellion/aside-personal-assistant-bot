// Triggers live AI voice calls on WhatsApp.
//
// The actual calling agent can't run here: it needs the WhatsApp VoIP WASM
// stack, a persistent linked-device auth dir, and a real-time audio pipeline -
// none of which survive Heroku's ephemeral filesystem and dyno cycling. It
// runs on the AWS EC2 box instead (same host as the OpenWA gateway), behind
// the same Caddy HTTPS endpoint, and this module just triggers it.
//
// Env:
//   CALL_API_URL   e.g. https://100.51.171.108.sslip.io/call
//   CALL_API_KEY

const BASE = (process.env.CALL_API_URL || '').replace(/\/$/, '');
const API_KEY = process.env.CALL_API_KEY || '';

function configured() {
  return !!(BASE && API_KEY);
}

async function req(method, pathname, body) {
  if (!configured()) throw new Error('Voice calling is not configured (CALL_API_URL/CALL_API_KEY missing).');
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      'X-API-Key': API_KEY,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* non-JSON */ }
  return { status: res.status, body: json };
}

/**
 * Place a live AI call.
 * @param {string} to    phone digits, country code included
 * @param {string} goal  what the AI should accomplish on the call
 * @param {string} name  who it's calling, so the AI can greet them properly
 */
async function placeCall({ to, goal, name }) {
  const digits = String(to).replace(/[^\d]/g, '');
  if (digits.length < 7) throw new Error('That does not look like a real phone number.');
  if (!String(goal || '').trim()) throw new Error('Refusing to place a call with no purpose.');

  const r = await req('POST', '/api/call', { to: digits, goal: String(goal).trim(), name });
  if (r.status === 202) return r.body;
  if (r.status === 409) throw new Error('A call is already in progress - only one at a time.');
  throw new Error(`Call failed to start (${r.status}): ${JSON.stringify(r.body).slice(0, 200)}`);
}

async function status() {
  const r = await req('GET', '/api/call/status');
  return r.body || {};
}

async function jobLog(jobId) {
  const r = await req('GET', `/api/call/${jobId}/log`);
  return r.body;
}

module.exports = { configured, placeCall, status, jobLog };
