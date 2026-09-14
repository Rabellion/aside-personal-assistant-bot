#!/usr/bin/env node
// Local agent - runs on Huzaifa's PC, not on Heroku.
//
// It dials out to the Heroku bot over a WebSocket and waits for work. When a
// task arrives it runs the chosen CLI (Claude Code / Codex / Gemini) *locally*,
// which means those agents get their real tool calling: shell, filesystem,
// and anything else on this machine, including the browser.
//
// Run it with:
//   node local-agent.js
// Needs these env vars (see .env.example):
//   BRIDGE_URL            wss://aside-personal-assistant-bot-XXXX.herokuapp.com/agent
//   AGENT_SHARED_SECRET   must match the Heroku config var of the same name
//
// SECURITY: this executes AI-directed commands on your machine with tools
// enabled. Only run it while you want that, and never share the secret.

const os = require('os');
// cross-spawn (not plain child_process.spawn) because it correctly resolves
// Windows .cmd/.bat shims AND quotes each argument individually. Plain
// spawn(..., {shell:true}) on Windows just joins file+args with a naive
// single space and applies NO quoting at all - a multi-word, multi-line
// prompt gets torn into a jumble of separate tokens before the CLI ever
// sees it, which is why the CLI reported an empty/missing prompt even
// though the earlier .cmd-launch crash was already fixed.
const spawn = require('cross-spawn');
const WebSocket = require('ws');

// Never let one bad task take the whole agent (and your PowerShell window)
// down. A CLI tool's own unrestricted shell/file access is the real risk
// surface here already, by design - this is just about staying online.
process.on('uncaughtException', (err) => {
  console.error('[agent] uncaught exception (continuing):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[agent] unhandled rejection (continuing):', err);
});

const BRIDGE_URL = process.env.BRIDGE_URL;
const SECRET = process.env.AGENT_SHARED_SECRET;
const WORKDIR = process.env.AGENT_WORKDIR || os.homedir();

if (!BRIDGE_URL || !SECRET) {
  console.error('BRIDGE_URL and AGENT_SHARED_SECRET must be set.');
  process.exit(1);
}

// Same providers as the server, but with local paths and full tool access.
const LOCAL_PROVIDERS = {
  anthropic: {
    bin: 'claude',
    args: (prompt, modelId) => {
      const a = ['-p', prompt, '--dangerously-skip-permissions'];
      if (modelId) a.push('--model', modelId);
      return a;
    },
  },
  openai: {
    bin: 'codex',
    args: (prompt, modelId) => {
      const a = ['exec', prompt, '--skip-git-repo-check', '--sandbox', 'danger-full-access'];
      if (modelId) a.push('--model', modelId);
      return a;
    },
  },
  google: {
    bin: 'gemini',
    args: (prompt, modelId) => {
      const a = ['-p', prompt, '--approval-mode', 'yolo', '--skip-trust'];
      if (modelId) a.push('-m', modelId);
      return a;
    },
  },
};

function buildAgentPrompt(userPrompt) {
  return [
    "You are Huzaifa's autonomous desktop personal assistant, working from a Discord DM.",
    'Complete the request using local tools when that helps: shell, filesystem and browser automation.',
    'You are operating on Huzaifa\'s own PC. Be proactive, inspect what you need, and report the actual result.',
    'Never impersonate Huzaifa. Do not send external messages, make purchases, sign documents, delete data, or change account security without explicit confirmation from Huzaifa in this conversation.',
    'For a Discord DM to a friend, tell Huzaifa to use the bot\'s /dm command, which sends as the assistant and relays replies.',
    '',
    `User request: ${userPrompt}`,
  ].join('\n');
}

function runLocal(provider, modelId, prompt, onProgress) {
  return new Promise((resolve) => {
    const spec = LOCAL_PROVIDERS[provider];
    if (!spec) {
      resolve({ ok: false, text: `Local agent doesn't know provider "${provider}".` });
      return;
    }

    let child;
    try {
      child = spawn(spec.bin, spec.args(prompt, modelId), {
        cwd: WORKDIR,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, text: `Couldn't start ${spec.bin} locally: ${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (onProgress) onProgress(s);
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, text: `Couldn't start ${spec.bin} locally: ${err.message}. Is it installed and on PATH?` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0 && stdout.trim()) {
        resolve({ ok: true, text: stdout.trim() });
      } else {
        resolve({ ok: false, text: (stderr || stdout || `exit code ${code}`).trim().slice(0, 1500) });
      }
    });
  });
}

let ws = null;
let reconnectDelay = 1000;
let heartbeatTimer = null;
// Heroku's router drops any connection idle for 55s (H15 "Idle connection").
// A task that runs for minutes without printing anything would otherwise get
// its connection killed out from under it, losing the result.
const HEARTBEAT_MS = 25000;

function connect() {
  const url = `${BRIDGE_URL}?token=${encodeURIComponent(SECRET)}`;
  ws = new WebSocket(url);

  ws.on('open', () => {
    reconnectDelay = 1000;
    console.log('[agent] connected to bridge');

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try { ws.ping(); } catch (_) { /* ignore */ }
      }
    }, HEARTBEAT_MS);
    ws.send(JSON.stringify({
      type: 'hello',
      host: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      tools: ['shell', 'filesystem', 'browser'],
      workdir: WORKDIR,
    }));
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'welcome') {
      console.log(`[agent] bridge protocol v${msg.protocol}`);
      return;
    }

    if (msg.type === 'task') {
      console.log(`[agent] task ${msg.taskId}: ${msg.provider}/${msg.modelId || 'default'}`);
      let result;
      try {
        let lastSent = 0;
        result = await runLocal(msg.provider, msg.modelId, buildAgentPrompt(msg.prompt), () => {
          // Throttled heartbeat so the bot can keep the typing indicator alive.
          const now = Date.now();
          if (now - lastSent > 5000) {
            lastSent = now;
            try { ws.send(JSON.stringify({ type: 'progress', taskId: msg.taskId, text: '' })); } catch (_) { /* ignore */ }
          }
        });
      } catch (err) {
        // Belt and braces: runLocal() shouldn't throw, but if it ever does,
        // report it instead of taking the agent down.
        result = { ok: false, text: `Local agent hit an unexpected error: ${err.message}` };
      }
      try {
        ws.send(JSON.stringify({ type: 'result', taskId: msg.taskId, ok: result.ok, text: result.text }));
      } catch (err) {
        console.log('[agent] failed to send result:', err.message);
      }
    }
  });

  ws.on('close', (code, reason) => {
    clearInterval(heartbeatTimer);
    console.log(`[agent] disconnected (${code} ${reason}). Reconnecting in ${reconnectDelay / 1000}s`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  });

  ws.on('error', (err) => {
    console.log('[agent] socket error:', err.message);
  });
}

connect();
