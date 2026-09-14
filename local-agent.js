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
const { buildPersonalContext, MEMORY_DIR } = require('./personalContext');

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
  // Re-read Aside's memory from disk on EVERY task. No caching, so edits to
  // those .md files take effect on the very next message.
  let personal = '';
  try {
    personal = buildPersonalContext();
  } catch (err) {
    console.log('[agent] could not read Aside memory:', err.message);
  }

  return [
    personal,
    "You are Huzaifa's autonomous desktop assistant, reached through a Discord DM.",
    '',
    'IMPORTANT - where you are actually running:',
    `You are executing directly on Huzaifa's own ${os.platform() === 'win32' ? 'Windows' : os.platform()} PC (hostname ${os.hostname()}),`,
    'as his own user account, with your normal tools enabled and approvals already granted.',
    'You are NOT in a container, VM, or sandbox. This is his real desktop.',
    'So you genuinely can inspect and control this machine - do not claim otherwise.',
    '',
    'Use your shell/command tool for real work. On Windows, for example:',
    '  - open a drive or folder in File Explorer:  explorer.exe E:\\',
    '  - launch an app:                            start "" "notepad.exe"',
    '  - list files:                               dir /b "C:\\path"',
    '  - anything else:                            run it via PowerShell',
    'Actually run the command rather than only describing it, then report what happened.',
    'If a command fails, read the error and try a sensible alternative before giving up.',
    '',
    'For anything on the web - reading email, the university CMS, looking something up,',
    'filling a form - you have Chrome DevTools browser tools available over MCP.',
    'Use them rather than saying you cannot browse.',
    'They are attached to his REAL, already-running Chrome: his own profile, his own',
    'open tabs, already signed in to Gmail, WhatsApp, the CMS and so on. So do not',
    'ask him to log in, and never ask for or guess credentials. If a page genuinely',
    'shows a logged-out state, report that instead of trying to authenticate.',
    'Be careful: these are his real live sessions, not a scratch browser. Read freely,',
    'but do not send, delete, purchase or submit anything without asking him first.',
    '',
    'Boundaries: never impersonate Huzaifa. Do not send messages to other people,',
    'make purchases, sign documents, delete data, or change account/security settings',
    'without explicit confirmation from him first. To DM a friend on Discord, tell him',
    "to use the bot's /dm command (or just phrase it as 'tell <name> ...'), which sends",
    'as the assistant and relays replies back.',
    '',
    'Reply conversationally and concisely, as a personal assistant in a chat - not as a report.',
    '',
    `Huzaifa's request: ${userPrompt}`,
  ].filter(Boolean).join('\n');
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
    let memoryOk = false;
    try { memoryOk = !!buildPersonalContext(); } catch (_) { memoryOk = false; }
    console.log(`[agent] Aside memory: ${memoryOk ? 'found at ' + MEMORY_DIR : 'NOT found at ' + MEMORY_DIR}`);

    ws.send(JSON.stringify({
      type: 'hello',
      host: os.hostname(),
      platform: `${os.platform()} ${os.release()}`,
      tools: ['shell', 'filesystem', 'browser'].concat(memoryOk ? ['aside-memory'] : []),
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
