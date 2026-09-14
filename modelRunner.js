// Runs a prompt through one of the three CLI-based model backends, each
// authenticated via its own subscription (not a pay-per-token API key).
const { spawn } = require('child_process');

const TIMEOUT_MS = 1000 * 60 * 4; // 4 minutes - reasoning models can be slow

const MODELS = {
  claude: {
    label: 'Claude (via Claude Code / your Claude subscription)',
    bin: 'claude',
    // -p / --print = non-interactive "print mode": run once, print the reply, exit.
    // --model comes from the currently selected Claude variant (see CLAUDE_MODELS
    // below, switchable at runtime with /claudemodel), falling back to the
    // CLAUDE_MODEL env var, then the hardcoded default.
    args: (prompt, opts = {}) => ['-p', prompt, '--model', opts.claudeModel || process.env.CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL, '--dangerously-skip-permissions'],
  },
  chatgpt: {
    label: 'ChatGPT (via Codex CLI / your ChatGPT subscription)',
    bin: 'codex',
    // `codex exec` = non-interactive automation mode.
    args: (prompt) => ['exec', prompt, '--full-auto'],
  },
  gemini: {
    label: 'Gemini (via Gemini CLI / your Gemini subscription)',
    bin: 'gemini',
    args: (prompt) => ['-p', prompt],
  },
  aside: {
    label: 'Aside (your real browser/Gmail/WhatsApp/CMS agent)',
    // Special-cased in index.js: this bot never answers directly for
    // "aside" mode. It stays silent and lets your Aside polling routine
    // (which actually has your browser/accounts) pick up the message on
    // its next run, since a Heroku dyno has no access to your local
    // Aside session, browser profile, or logged-in accounts.
    bin: null,
    args: () => [],
  },
};

const DEFAULT_MODEL = 'aside';

// Claude variants selectable at runtime via the bot's /claudemodel command.
// These are the model IDs Claude Code's --model flag expects.
const CLAUDE_MODELS = {
  'claude-sonnet-5': 'Claude Sonnet 5 (balanced, default)',
  'claude-opus-5': 'Claude Opus 5 (most capable, slower)',
  'claude-haiku-4-5': 'Claude Haiku 4.5 (fastest, lightweight)',
};
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';

function isValidClaudeModel(key) {
  return Object.prototype.hasOwnProperty.call(CLAUDE_MODELS, key);
}

function listClaudeModels() {
  return Object.entries(CLAUDE_MODELS).map(([key, label]) => ({ key, label }));
}

function isValidModel(key) {
  return Object.prototype.hasOwnProperty.call(MODELS, key);
}

function listModels() {
  return Object.entries(MODELS).map(([key, m]) => ({ key, label: m.label }));
}

function runModel(modelKey, prompt, opts = {}) {
  const model = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(model.bin, model.args(prompt, opts), {
      env: process.env,
      shell: false,
      // Close stdin immediately - without this, some CLIs (Claude Code
      // included) hang waiting for piped input that will never arrive,
      // since Node's spawn() leaves stdin open as a pipe by default.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ ok: false, text: `${model.label} timed out after ${TIMEOUT_MS / 1000}s.` });
      }
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, text: `Couldn't start ${model.label}: ${err.message}. Is it installed and authenticated?` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve({ ok: true, text: stdout.trim() });
      } else {
        const detail = (stderr || stdout || `exit code ${code}`).trim().slice(0, 1500);
        resolve({ ok: false, text: `${model.label} failed: ${detail}` });
      }
    });
  });
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  isValidModel,
  listModels,
  runModel,
  CLAUDE_MODELS,
  DEFAULT_CLAUDE_MODEL,
  isValidClaudeModel,
  listClaudeModels,
};
