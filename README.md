# Aside Personal Assistant

Private Discord assistant for Huzaifa. It combines an always-on Heroku Discord
bot with an optional local agent on Huzaifa's PC.

## What it does

- Normal Discord DMs: Claude, ChatGPT/Codex, or Gemini replies.
- `/model`: provider dropdown, then a **live** model catalogue dropdown. No
  stale hardcoded models.
- `/dm @friend <message>`: the bot DMs a friend **as Huzaifa's assistant**,
  never pretending to be Huzaifa. When they reply, it forwards that reply to
  Huzaifa; replying to the forwarded message sends a response back to them.
- `/agent`: shows whether the local PC agent is online.
- When the local agent is online, Claude/Codex/Gemini tasks run on Huzaifa's
  real PC with shell, filesystem and browser tooling instead of on Heroku.

## Architecture

| Component | Runs where | Purpose |
|---|---|---|
| `index.js` | Heroku web dyno, 24/7 | Discord Gateway, model selection, DM relay, WebSocket bridge |
| `bridge.js` | same web dyno | Authenticated WebSocket endpoint for the PC agent |
| `local-agent.js` | Huzaifa's Windows PC | Executes Claude/Codex/Gemini with local tool access |
| `relay.js` | Heroku | Two-way assistant-to-friend DM relay |

Heroku is intentionally just the always-on front door. It cannot access
Huzaifa's computer, Chrome profile, or logged-in accounts. The local agent
solves that without exposing a port on his home network: it makes an outbound,
authenticated WebSocket connection to Heroku.

## Provider auth

- **Anthropic**: Claude Code subscription token (`CLAUDE_CODE_OAUTH_TOKEN`)
- **OpenAI**: ChatGPT/Codex OAuth copied as `CODEX_AUTH_JSON_BASE64`
- **Google**: AI Studio key (`GEMINI_API_KEY`)

Google retired consumer Gemini Pro / Ultra OAuth access for Gemini CLI in June
2026. Therefore an API key is currently the only workable headless Google
route; it does not consume the Gemini Pro subscription.

## Heroku config vars

```text
DISCORD_TOKEN
DISCORD_APPLICATION_ID
OWNER_DISCORD_USER_ID
OWNER_NAME
CLAUDE_CODE_OAUTH_TOKEN
CODEX_AUTH_JSON_BASE64
GEMINI_API_KEY
AGENT_SHARED_SECRET
```

`AGENT_SHARED_SECRET` must be a long random secret and must match the value in
the PC agent's `.env` file.

## Run the PC agent

Use the `local-agent-setup` bundle generated for Huzaifa, or copy
`local-agent.js`, `package.json`, `.env`, and `start-agent.ps1` to a folder on
his PC. Then run:

```powershell
.\start-agent.ps1
```

Check Discord with `/agent`. When it reports online, the LLM selected through
`/model` is running on the PC. Closing the PowerShell window takes it offline.

## Security

The local agent passes tasks to CLIs with tool approvals disabled. That is what
makes it autonomous, but it also has real risk. The bot only dispatches work
originating from the configured owner Discord account; keep the secret private
and stop the agent whenever it is not needed.

## Discord limitations

A Discord bot can only DM a user who shares a server with the bot. To message a
friend with `/dm`, that friend must be in a server that includes this bot.
Discord itself enforces this; no bot can bypass it.

## Aside integration

The existing **Aside** event-driven routine handles messages while `/model` is
set to Aside, using its real logged-in browser, Gmail, WhatsApp and CMS access.
Aside's native Discord channel integration is a supported alternative, but the
current account reports that it requires an Aside Pro plan.

For Claude/Codex/Gemini, the local agent is the cross-provider equivalent: it
runs the selected provider locally with access to the PC and browser. There is
not currently a public standalone API for external LLMs to directly drive an
existing Aside browser session.
