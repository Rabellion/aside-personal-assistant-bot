// Writes subscription-based CLI credentials to the paths each CLI expects,
// from base64-encoded environment variables. This runs once at process boot
// so the same credentials survive a Heroku dyno restart (Heroku's filesystem
// is ephemeral, but Config Vars persist).
//
// Expected env vars (all optional - only wire up what you actually have):
//   CLAUDE_CODE_OAUTH_TOKEN     - long-lived token from `claude setup-token` (Claude Pro/Max)
//   CODEX_AUTH_JSON_BASE64      - base64 of your local ~/.codex/auth.json (ChatGPT login)
//   GEMINI_API_KEY              - AI Studio key from https://aistudio.google.com/apikey
//
// Google is the odd one out: on 2026-06-18 Google stopped serving Gemini CLI /
// Code Assist requests for the consumer Google AI Pro and Ultra tiers and moved
// those users to the Antigravity suite. Antigravity's container token storage is
// currently write-only, so a subscription OAuth credential cannot be copied onto
// a headless dyno the way the Claude and ChatGPT ones can. An AI Studio API key
// is the only path that works headlessly today.

const fs = require('fs');
const os = require('os');
const path = require('path');

function writeBase64File(envVarName, destPath) {
  const value = process.env[envVarName];
  if (!value) {
    console.log(`[credentials] ${envVarName} not set, skipping ${destPath}`);
    return false;
  }
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(destPath, Buffer.from(value, 'base64'), { mode: 0o600 });
  console.log(`[credentials] wrote ${destPath} from ${envVarName}`);
  return true;
}

function setupCredentials() {
  const home = os.homedir();

  // Claude Code: CLAUDE_CODE_OAUTH_TOKEN is read directly as an env var by
  // the `claude` CLI itself - nothing to write to disk, just make sure it's
  // present so we can warn early if it's missing.
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.log('[credentials] CLAUDE_CODE_OAUTH_TOKEN not set - the "claude" model will not work until it is.');
  }

  // Codex CLI expects ~/.codex/auth.json (or $CODEX_HOME/auth.json).
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  writeBase64File('CODEX_AUTH_JSON_BASE64', path.join(codexHome, 'auth.json'));

  // Gemini CLI reads GEMINI_API_KEY straight from the environment.
  if (!process.env.GEMINI_API_KEY) {
    console.log('[credentials] GEMINI_API_KEY not set - the Google provider will not work until it is.');
  }

  // Legacy: only used if you still have a working Gemini OAuth credential file.
  if (process.env.GEMINI_AUTH_JSON_BASE64) {
    const geminiAuthPath = process.env.GEMINI_AUTH_JSON_PATH || path.join(home, '.gemini', 'oauth_creds.json');
    writeBase64File('GEMINI_AUTH_JSON_BASE64', geminiAuthPath);
  }
}

module.exports = { setupCredentials };
