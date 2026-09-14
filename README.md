# Aside Personal Assistant - Discord Bot

A private Discord bot that DMs like a real person - no slash command needed
to chat. Send it a normal message and it replies using whichever model is
currently active (Claude, ChatGPT, or Gemini), each authenticated through
your own subscription via its CLI (Claude Code, Codex CLI, Gemini CLI) -
not pay-per-token API billing.

Use `/model` to switch which backend answers your DMs, `/status` to check
which one is active, `/help` for a quick reminder.

This bot is intentionally single-user: it only ever responds to the Discord
user ID in `OWNER_DISCORD_USER_ID` and ignores everyone else, even in a
server it's a member of.

## Why a bot at all, given Aside already DMs you?

Your Aside routines (separate from this bot, see your Aside memory) already
DM you your daily schedule and can act on real browser/Gmail/WhatsApp/CMS
tasks by polling this same DM every 15 minutes. This bot adds instant,
always-on chat with Claude/ChatGPT/Gemini directly, on your own
subscriptions, without waiting for the next Aside poll cycle.

## One-time setup

### 1. Get subscription-based credentials for each model (run locally, once)

These all need to happen on a machine where you can complete a normal
browser OAuth login - your own Windows PC is fine.

**Claude (Claude Pro/Max):**
```
claude setup-token
```
Copy the printed token into `CLAUDE_CODE_OAUTH_TOKEN`.

**ChatGPT (via Codex CLI):**
```
codex login
```
This writes `~/.codex/auth.json`. Base64-encode it:
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\.codex\auth.json"))
```
Paste the result into `CODEX_AUTH_JSON_BASE64`.

**Gemini:**
```
gemini
```
Complete the browser login once, then locate the credentials file it wrote
(commonly `~/.gemini/oauth_creds.json` - check your Gemini CLI version's
docs if it's elsewhere) and base64-encode it the same way into
`GEMINI_AUTH_JSON_BASE64`. Set `GEMINI_AUTH_JSON_PATH` if the destination
path on the server should differ from the default in `credentials.js`.

All three tokens are subscription credentials, not payment-per-token API
keys - treat them like passwords.

### 2. Set the config vars on Heroku

In the Heroku dashboard for this app, go to **Settings -> Config Vars** and
add everything from `.env.example` with your real values (`DISCORD_TOKEN`
and `DISCORD_APPLICATION_ID` come from the Discord Developer Portal for
this bot application).

### 3. Register slash commands (once, and again whenever commands change)

From your local machine, with the same `.env` filled in:
```
npm install
npm run register-commands
```

### 4. Deploy

Connect this repo to Heroku (GitHub integration or `git push heroku main`),
make sure the **worker** dyno is turned on (Heroku disables it by default -
`heroku ps:scale worker=1`), and it will log in and go online in Discord.

## Local development

```
npm install
cp .env.example .env   # fill in values
npm start
```
