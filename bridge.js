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

let wss = null;
let agentSocket = null;
let agentInfo = null;
const pending = new Map(); // taskId -> { resolve, timer, onProgress }

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
  }
}

function startBridge({ port, secret, onReady }) {
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const status = agentStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: status }));
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
    ws.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL_VERSION }));

    ws.on('message', handleAgentMessage);

    ws.on('close', () => {
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

module.exports = { startBridge, dispatchToAgent, isAgentOnline, agentStatus };
