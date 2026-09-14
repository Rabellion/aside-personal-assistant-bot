// Writes subscription-based CLI credentials to the paths each CLI expects,
// from base64-encoded environment variables. This runs once at process boot
// so the same credentials survive a Heroku dyno restart (Heroku's filesystem
// is ephemeral, but Config Vars persist).
//
// Expected env vars (all optional - only wire up what you actually have):
//   CLAUDE_CODE_OAUTH_TOKEN     - long-lived token from `claude setup-token` (Claude Pro/Max)
//   CODEX_AUTH_JSON_BASE64      - base64 of your local ~/.codex/auth.json (ChatGPT login)
//   GEMINI_AUTH_JSON_BASE64     - base64 of your local Gemini CLI credentials file
//   GEMINI_AUTH_JSON_PATH       - where Gemini CLI expects that file (defaults below)

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

  // Gemini CLI's credentials path can vary by version; override with
  // GEMINI_AUTH_JSON_PATH if the default below doesn't match your install.
  const geminiAuthPath = process.env.GEMINI_AUTH_JSON_PATH || path.join(home, '.gemini', 'oauth_creds.json');
  writeBase64File('GEMINI_AUTH_JSON_BASE64', geminiAuthPath);
}

module.exports = { setupCredentials };
