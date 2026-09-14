// Runs a prompt through one of the three CLI-based model backends, each
// authenticated via its own subscription (not a pay-per-token API key).
const { spawn } = require('child_process');

const TIMEOUT_MS = 1000 * 60 * 4; // 4 minutes - reasoning models can be slow

const MODELS = {
  claude: {
    label: 'Claude (via Claude Code / your Claude subscription)',
    bin: 'claude',
    // -p / --print = non-interactive "print mode": run once, print the reply, exit.
    args: (prompt) => ['-p', prompt, '--dangerously-skip-permissions'],
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
};

const DEFAULT_MODEL = 'claude';

function isValidModel(key) {
  return Object.prototype.hasOwnProperty.call(MODELS, key);
}

function listModels() {
  return Object.entries(MODELS).map(([key, m]) => ({ key, label: m.label }));
}

function runModel(modelKey, prompt) {
  const model = MODELS[modelKey] || MODELS[DEFAULT_MODEL];
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(model.bin, model.args(prompt), {
      env: process.env,
      shell: false,
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

module.exports = { MODELS, DEFAULT_MODEL, isValidModel, listModels, runModel };
