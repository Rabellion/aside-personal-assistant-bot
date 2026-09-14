// Runs a prompt through one of the CLI-based model backends.
//
// Each provider is authenticated with the user's own subscription/account
// where that is still possible:
//   anthropic -> Claude Code, CLAUDE_CODE_OAUTH_TOKEN (Claude subscription)
//   openai    -> Codex CLI, ~/.codex/auth.json (ChatGPT subscription)
//   google    -> Gemini CLI, GEMINI_API_KEY (see note below)
//
// NOTE on Google: as of 2026-06-18 Google retired "Login with Google" for
// Gemini CLI / Code Assist on the consumer Google AI Pro / Ultra tiers and
// pushed those users to the Antigravity suite. Antigravity's container token
// storage is currently write-only, so a subscription OAuth token cannot be
// copied onto a headless server the way the Claude and ChatGPT ones can.
// An AI Studio API key is therefore the only working headless path for Google.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TIMEOUT_MS = 1000 * 60 * 4; // reasoning models can be slow
const MODEL_CACHE_TTL_MS = 1000 * 60 * 10;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function readCodexAuth() {
  try {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return JSON.parse(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function codexClientVersion() {
  // The codex models endpoint gates its response on the calling client
  // version and returns an empty list for versions it considers too old.
  if (process.env.CODEX_CLIENT_VERSION) return process.env.CODEX_CLIENT_VERSION;
  try {
    return require('@openai/codex/package.json').version;
  } catch (_) {
    return '0.154.0';
  }
}

// ---------------------------------------------------------------------------
// providers
// ---------------------------------------------------------------------------

const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    bin: 'claude',
    defaultModel: 'claude-sonnet-5',
    fallbackModels: [
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
    ],
    async listModels() {
      const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not set.');
      const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
      });
      if (!res.ok) throw new Error(`Anthropic model list failed (${res.status}).`);
      const json = await res.json();
      return (json.data || []).map((m) => ({ id: m.id, label: m.display_name || m.id }));
    },
    // -p / --print = non-interactive print mode: run once, print reply, exit.
    args: (prompt, modelId) => [
      '-p', prompt,
      '--model', modelId,
      '--dangerously-skip-permissions',
    ],
  },

  openai: {
    label: 'OpenAI (ChatGPT / Codex)',
    bin: 'codex',
    defaultModel: 'gpt-5.5',
    fallbackModels: [
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
    ],
    async listModels() {
      const auth = readCodexAuth();
      if (!auth || !auth.tokens || !auth.tokens.access_token) {
        throw new Error('No Codex auth.json found - set CODEX_AUTH_JSON_BASE64.');
      }
      const res = await fetch(
        `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(codexClientVersion())}`,
        {
          headers: {
            Authorization: `Bearer ${auth.tokens.access_token}`,
            'chatgpt-account-id': auth.tokens.account_id || '',
          },
        },
      );
      if (!res.ok) throw new Error(`Codex model list failed (${res.status}).`);
      const json = await res.json();
      return (json.models || [])
        // "hide" entries are internal helper models, not user-selectable ones.
        .filter((m) => m.visibility === 'list')
        .map((m) => ({ id: m.slug, label: m.display_name || m.slug }));
    },
    // `codex exec` streams progress to stderr and prints ONLY the final agent
    // message to stdout, so stdout needs no post-processing.
    //   --skip-git-repo-check : the dyno's /app is not a git checkout
    //   --sandbox danger-full-access : the dyno is already an isolated
    //     container, and Codex's own landlock/seccomp sandbox cannot nest
    //     inside it (it hangs instead of erroring)
    //   --ephemeral : don't persist session rollout files to Heroku's
    //     throwaway filesystem
    args: (prompt, modelId) => [
      'exec', prompt,
      '--model', modelId,
      '--skip-git-repo-check',
      '--sandbox', 'danger-full-access',
      '--ephemeral',
    ],
  },

  google: {
    label: 'Google (Gemini)',
    bin: 'gemini',
    defaultModel: 'gemini-pro-latest',
    fallbackModels: [
      { id: 'gemini-pro-latest', label: 'Gemini Pro Latest' },
      { id: 'gemini-flash-latest', label: 'Gemini Flash Latest' },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
    ],
    async listModels() {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw new Error(
          'GEMINI_API_KEY is not set. Google retired subscription login for Gemini CLI, ' +
          'so an AI Studio key from https://aistudio.google.com/apikey is required.',
        );
      }
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`,
      );
      if (!res.ok) throw new Error(`Gemini model list failed (${res.status}).`);
      const json = await res.json();
      // The catalogue also contains image / TTS / transcription variants that
      // are useless for a chat bot. Keep them, but sort plain text-chat models
      // first so they survive Discord's 25-option menu limit.
      const isChat = (id) => !/(image|tts|transcribe|embedding|banana|gemma)/i.test(id);
      return (json.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || m.name }))
        .sort((a, b) => (isChat(b.id) ? 1 : 0) - (isChat(a.id) ? 1 : 0));
    },
    // --approval-mode yolo auto-approves actions so a headless run never
    // blocks on a confirmation prompt.
    args: (prompt, modelId) => [
      '-p', prompt,
      '-m', modelId,
      '--approval-mode', 'yolo',
    ],
  },

  aside: {
    label: 'Aside (your real browser / Gmail / WhatsApp / CMS agent)',
    // Deliberately has no CLI. index.js short-circuits this provider and stays
    // silent so the Aside event-driven routine - which actually has the
    // browser and logged-in accounts - handles the message instead.
    bin: null,
    defaultModel: null,
    fallbackModels: [],
    async listModels() { return []; },
    args: () => [],
  },
};

const DEFAULT_PROVIDER = 'aside';

function isValidProvider(key) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key);
}

function listProviders() {
  return Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label }));
}

// --- model list cache -------------------------------------------------------

const modelCache = new Map(); // providerKey -> { at, models }

async function getModels(providerKey, { force = false } = {}) {
  const provider = PROVIDERS[providerKey];
  if (!provider) throw new Error(`Unknown provider "${providerKey}".`);

  const cached = modelCache.get(providerKey);
  if (!force && cached && Date.now() - cached.at < MODEL_CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    const models = await provider.listModels();
    if (models && models.length) {
      modelCache.set(providerKey, { at: Date.now(), models });
      return models;
    }
    // An empty live list is not useful - fall back to the static list.
    return provider.fallbackModels;
  } catch (err) {
    // Never hard-fail the picker just because a listing endpoint is down.
    if (provider.fallbackModels.length) return provider.fallbackModels;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

function runModel(providerKey, modelId, prompt) {
  const provider = PROVIDERS[providerKey];

  return new Promise((resolve) => {
    if (!provider) {
      resolve({ ok: false, text: `Unknown provider "${providerKey}".` });
      return;
    }
    // Guard: spawn() throws "The 'file' argument must be of type string.
    // Received null" when bin is null, which is exactly what aside is.
    if (!provider.bin) {
      resolve({ ok: false, text: `${provider.label} has no CLI to run - Aside handles it directly.` });
      return;
    }

    const resolvedModel = modelId || provider.defaultModel;
    let settled = false;

    const child = spawn(provider.bin, provider.args(prompt, resolvedModel), {
      env: process.env,
      shell: false,
      // Close stdin immediately. Without this, these CLIs hang waiting on
      // piped input that never arrives, because Node leaves stdin open as a
      // pipe by default.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, text: `${provider.label} timed out after ${TIMEOUT_MS / 1000}s.` });
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, text: `Couldn't start ${provider.label}: ${err.message}. Is it installed and authenticated?` });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) {
        resolve({ ok: true, text: stdout.trim() });
      } else {
        const detail = (stderr || stdout || `exit code ${code}`).trim().slice(0, 1500);
        resolve({ ok: false, text: `${provider.label} failed: ${detail}` });
      }
    });
  });
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  isValidProvider,
  listProviders,
  getModels,
  runModel,
};
