// WebSocket bridge between the always-on Heroku bot and a local agent running
// on Huzaifa's PC.
//
// Why this exists: a Heroku dyno is a throwaway Linux container. It has no
// access to his machine, his files, his real Chrome profile or his logged-in
// accounts. So the dyno can host the Discord connection 24/7, but anything
// that has to actually *touch his computer* gets handed to a local agent.
//
// The PC dials out to Heroku (not the other way around), so this works behind
// NAT with no port forwarding.
//
// SECURITY: a connected local agent will execute agent tasks on his machine.
// The shared secret in AGENT_SHARED_SECRET is the only thing protecting that,
// so it must be long and random, and only tasks that originated from the
// owner's own DMs are ever dispatched.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PROTOCOL_VERSION = 1;
const TASK_TIMEOUT_MS = 1000 * 60 * 10; // local agent tasks may be long
// Heroku's router closes any connection with no traffic for 55s (error H15
// "Idle connection"). A long-running agent task can easily go that long with
// nothing to say, so without an explicit heartbeat the bridge gets torn down
// mid-task roughly every minute. Ping well inside that window.
const HEARTBEAT_MS = 25000;

let wss = null;
let agentSocket = null;
let agentInfo = null;
const pending = new Map(); // taskId -> { resolve, timer, onProgress }
let onWhatsAppInbound = null; // set by index.js

function isAgentOnline() {
  return !!(agentSocket && agentSocket.readyState === 1);
}

function agentStatus() {
  if (!isAgentOnline()) return { online: false };
  return {
    online: true,
    host: agentInfo && agentInfo.host,
    platform: agentInfo && agentInfo.platform,
    tools: (agentInfo && agentInfo.tools) || [],
    connectedAt: agentInfo && agentInfo.connectedAt,
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Dispatch a task to the local agent. onProgress is called with partial text
// so Discord can show life during long runs.
function dispatchToAgent(task, onProgress) {
  return new Promise((resolve) => {
    if (!isAgentOnline()) {
      resolve({ ok: false, text: 'Local agent is not connected.' });
      return;
    }
    const taskId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(taskId);
      resolve({ ok: false, text: `Local agent timed out after ${TASK_TIMEOUT_MS / 1000}s.` });
    }, TASK_TIMEOUT_MS);

    pending.set(taskId, { resolve, timer, onProgress });
    try {
      agentSocket.send(JSON.stringify({ type: 'task', taskId, ...task }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(taskId);
      resolve({ ok: false, text: `Couldn't reach the local agent: ${err.message}` });
    }
  });
}

function handleAgentMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch (_) {
    return;
  }

  if (msg.type === 'hello') {
    agentInfo = {
      host: msg.host,
      platform: msg.platform,
      tools: msg.tools || [],
      connectedAt: new Date().toISOString(),
    };
    console.log(`[bridge] local agent online: ${msg.host} (${msg.platform})`);
    return;
  }

  if (msg.type === 'progress') {
    const entry = pending.get(msg.taskId);
    if (entry && entry.onProgress) entry.onProgress(msg.text || '');
    return;
  }

  if (msg.type === 'result') {
    const entry = pending.get(msg.taskId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.taskId);
    entry.resolve({ ok: !!msg.ok, text: msg.text || '(empty response)' });
    return;
  }

  // An inbound WhatsApp message the local gateway just received.
  if (msg.type === 'whatsapp-inbound' && onWhatsAppInbound) {
    onWhatsAppInbound(msg.payload || {});
  }
}

function setWhatsAppHandler(fn) {
  onWhatsAppInbound = fn;
}

let onCallEvent = null;
function setCallEventHandler(fn) {
  onCallEvent = fn;
}

// Recent OpenWA delivery ids, so a retried webhook (at-least-once delivery,
// per OpenWA's own docs) doesn't forward the same WhatsApp message twice.
const seenIdempotencyKeys = new Set();
const SEEN_KEYS_MAX = 500;
function rememberKey(key) {
  if (!key) return false;
  if (seenIdempotencyKeys.has(key)) return true;
  seenIdempotencyKeys.add(key);
  if (seenIdempotencyKeys.size > SEEN_KEYS_MAX) {
    const oldest = seenIdempotencyKeys.values().next().value;
    seenIdempotencyKeys.delete(oldest);
  }
  return false;
}

// Handles a raw OpenWA webhook delivery: verifies the HMAC over the exact raw
// bytes (per OpenWA's docs - a re-serialized parse can reorder keys and break
// the signature), dedupes, and forwards inbound messages only.
function handleWhatsAppWebhook(rawBody, headers, secret) {
  const signature = headers['x-openwa-signature'];
  if (secret) {
    if (!signature) return { status: 401, body: 'missing signature' };
    const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { status: 401, body: 'invalid signature' };
    }
  }

  let evt;
  try {
    evt = JSON.parse(rawBody.toString('utf8'));
  } catch (_) {
    return { status: 400, body: 'bad json' };
  }

  const idKey = headers['x-openwa-idempotency-key'] || evt.idempotencyKey;
  if (rememberKey(idKey)) return { status: 200, body: 'duplicate, already handled' };

  if (evt.event === 'message.received' && evt.data && !evt.data.fromMe && onWhatsAppInbound) {
    const d = evt.data;
    onWhatsAppInbound({
      from: d.chatId || d.from || '',
      senderName: d.notifyName || d.author || d.from || '',
      chatName: d.isGroup ? (d.chatId || '') : '',
      body: d.body || (d.type && d.type !== 'text' ? `[${d.type}]` : ''),
    });
  }

  return { status: 200, body: 'ok' };
}

function startBridge({ port, secret, whatsappWebhookSecret, onReady }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const status = agentStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: status }));
      return;
    }

    // Live call status/transcript pushed from the calling agent on EC2.
    // Reuses AGENT_SHARED_SECRET rather than adding another credential - the
    // calling agent is the same class of trusted component as the local agent.
    if (req.url === '/call-event' && req.method === 'POST') {
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total > 256 * 1024) { req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', async () => {
        try {
          const provided = req.headers['x-call-secret'];
          if (!secret || !provided || !safeEqual(String(provided), String(secret))) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('unauthorized');
            return;
          }
          const evt = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (onCallEvent) await onCallEvent(evt);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('ok');
        } catch (err) {
          console.log('[bridge] call-event error:', err.message);
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('bad request');
        }
      });
      return;
    }

    if (req.url === '/whatsapp-webhook' && req.method === 'POST') {
      const chunks = [];
      let total = 0;
      req.on('data', (c) => {
        total += c.length;
        if (total > 2 * 1024 * 1024) { req.destroy(); return; } // 2MB flood guard
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks);
          const lowerHeaders = {};
          for (const [k, v] of Object.entries(req.headers)) lowerHeaders[k.toLowerCase()] = v;
          const result = handleWhatsAppWebhook(raw, lowerHeaders, whatsappWebhookSecret);
          res.writeHead(result.status, { 'Content-Type': 'text/plain' });
          res.end(result.body);
        } catch (err) {
          console.log('[bridge] whatsapp webhook error:', err.message);
          res.writeHead(500);
          res.end('error');
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });

  wss = new WebSocketServer({ server, path: '/agent' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';

    if (!secret || !safeEqual(token, secret)) {
      console.log('[bridge] rejected agent connection: bad token');
      ws.close(4001, 'unauthorized');
      return;
    }

    // Only one local agent at a time. A reconnect replaces the old one.
    if (agentSocket && agentSocket.readyState === 1) {
      try { agentSocket.close(4000, 'replaced by new connection'); } catch (_) { /* ignore */ }
    }

    agentSocket = ws;
    ws.isAlive = true;
    ws.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION }));

    ws.on('pong', () => { ws.isAlive = true; });

    // Keep the connection hot so Heroku's 55s idle reaper doesn't kill it,
    // and drop genuinely dead sockets instead of letting them linger.
    const heartbeat = setInterval(() => {
      if (ws.readyState !== 1) return;
      if (!ws.isAlive) {
        console.log('[bridge] agent missed heartbeat, terminating socket');
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) { /* ignore */ }
    }, HEARTBEAT_MS);

    ws.on('message', handleAgentMessage);

    ws.on('close', () => {
      clearInterval(heartbeat);
      if (agentSocket === ws) {
        agentSocket = null;
        agentInfo = null;
        console.log('[bridge] local agent went offline');
        // Fail any in-flight work rather than letting it hang to timeout.
        for (const [taskId, entry] of pending.entries()) {
          clearTimeout(entry.timer);
          entry.resolve({ ok: false, text: 'Local agent disconnected mid-task.' });
          pending.delete(taskId);
        }
      }
    });

    ws.on('error', (err) => console.log('[bridge] agent socket error:', err.message));
  });

  server.listen(port, () => {
    console.log(`[bridge] listening on ${port}`);
    if (onReady) onReady();
  });

  return server;
}

module.exports = { startBridge, dispatchToAgent, isAgentOnline, agentStatus, setWhatsAppHandler, setCallEventHandler };
