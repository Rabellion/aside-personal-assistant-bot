const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');
const { setupCredentials } = require('./credentials');
const {
  PROVIDERS,
  DEFAULT_PROVIDER,
  isValidProvider,
  listProviders,
  getModels,
  runModel,
} = require('./modelRunner');
const {
  sendDM,
  forwardToOwner,
  resolveOwnerReply,
  describeSendError,
  getLastInbound,
} = require('./relay');
const { startBridge, dispatchToAgent, isAgentOnline, agentStatus, setWhatsAppHandler } = require('./bridge');
const contacts = require('./contacts');
const memory = require('./memory');
const reminders = require('./reminders');
const whatsapp = require('./whatsapp');
const { parseDmRequest, resolveRecipient } = require('./dmIntent');
const waTriggers = require('./waTriggers');
const voiceCall = require('./voiceCall');

setupCredentials();

const OWNER_ID = process.env.OWNER_DISCORD_USER_ID || '845391729549115402';
const OWNER_NAME = process.env.OWNER_NAME || 'Huzaifa';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let currentProvider = DEFAULT_PROVIDER;
let currentModelId = PROVIDERS[DEFAULT_PROVIDER].defaultModel;

function activeLabel() {
  const p = PROVIDERS[currentProvider];
  return currentModelId ? `${p.label} - \`${currentModelId}\`` : p.label;
}

function whereItRuns() {
  if (currentProvider === 'aside') return 'your Aside routine (real browser + accounts)';
  return isAgentOnline()
    ? 'your PC via the local agent (full tool access)'
    : 'the Heroku dyno (sandboxed - no access to your PC)';
}

function providerRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('model:provider')
      .setPlaceholder('Pick a provider')
      .addOptions(
        listProviders().map((p) => ({
          label: p.label.slice(0, 100),
          value: p.key,
          default: p.key === currentProvider,
        })),
      ),
  );
}

function modelRow(providerKey, models) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`model:pick:${providerKey}`)
      .setPlaceholder(`Pick a ${PROVIDERS[providerKey].label} model`)
      .addOptions(
        models.slice(0, 25).map((m) => ({
          label: (m.label || m.id).slice(0, 100),
          description: m.id.slice(0, 100),
          value: m.id.slice(0, 100),
          default: m.id === currentModelId,
        })),
      ),
  );
}

// Route a prompt to the best available executor: the user's PC if the local
// agent is up, otherwise the sandboxed dyno. Every provider gets the same
// remembered context, so switching /model doesn't reset the conversation.
// Tells any model how to schedule something that actually survives. Without
// this the model assumes it has to hold the promise itself, which it can't -
// its process exits seconds later.
function schedulingInstructions() {
  const now = new Date();
  return [
    '',
    `Current time: ${now.toISOString()} (${reminders.formatLocal(now.toISOString())} ${reminders.TZ}).`,
    'If Huzaifa asks to be reminded, pinged, or for anything to happen later, do NOT',
    'claim you will remember it yourself - your process ends when this reply is sent.',
    'Instead include a marker anywhere in your reply:',
    '  [[REMIND: <ISO-8601 datetime with offset> | <what to say>]]',
    `For example: [[REMIND: 2026-09-16T12:00:00+05:00 | upload ML Assignment 02 to the CMS]]`,
    'An always-on service records it and will DM him at that time even if everything',
    'else has restarted. The marker is stripped before he sees your reply, so just',
    'confirm naturally in your own words.',
    '',
  ].join('\n');
}

// If the message references WhatsApp and isn't already a resolved send
// request, pull in recent chat activity so the model can actually answer
// "what's new on WhatsApp" instead of claiming it can't check.
async function whatsappContext(prompt) {
  if (!whatsapp.configured() || !/\bwhatsapp\b/i.test(prompt)) return '';
  try {
    const chats = await whatsapp.listChats(10);
    if (!chats || !Array.isArray(chats) || !chats.length) return '';
    const summary = chats
      .slice(0, 10)
      .map((c) => `- ${c.name || c.id}: ${(c.lastMessage && c.lastMessage.body) || '(no recent text)'}`)
      .join('\n');
    return `Recent WhatsApp chats (for context, don't just recite this list):\n${summary}\n\n`;
  } catch (err) {
    console.log('[whatsapp] context fetch failed:', err.message);
    return '';
  }
}

async function think(channel, prompt) {
  await memory.load(channel);
  const context = memory.buildContext();
  const waContext = await whatsappContext(prompt);
  const fullPrompt = `${context}${waContext}${schedulingInstructions()}Huzaifa just said: ${prompt}`;
  console.log(`[think] provider=${currentProvider} model=${currentModelId} agentOnline=${isAgentOnline()} promptLen=${fullPrompt.length}`);

  let result;
  if (isAgentOnline() && currentProvider !== 'aside') {
    const res = await dispatchToAgent({
      provider: currentProvider,
      modelId: currentModelId,
      prompt: fullPrompt,
    });
    if (res.ok) {
      result = res;
    } else {
      console.log(`[think] local agent failed: ${String(res.text).slice(0, 200)} - falling back to dyno`);
      // If the PC run failed, still try the dyno so the user gets *something*.
      const fallback = await runModel(currentProvider, currentModelId, fullPrompt);
      result = fallback.ok
        ? { ok: true, text: `${fallback.text}\n\n_(local agent failed, answered from the server instead: ${res.text.slice(0, 200)})_` }
        : res;
    }
  } else {
    result = await runModel(currentProvider, currentModelId, fullPrompt);
  }

  console.log(`[think] done ok=${result.ok} textLen=${(result.text || '').length}`);

  // Pull out any scheduling the model asked for and hand it to the always-on
  // scheduler, so the promise outlives the CLI process that made it.
  const { cleaned, found } = reminders.extractMarkers(result.text || '');
  if (found.length) {
    const confirmations = [];
    for (const r of found) {
      try {
        const saved = await reminders.add(channel, r.when, r.text);
        confirmations.push(`Scheduled: **${saved.text}** - ${reminders.formatLocal(saved.at)}`);
        console.log(`[reminders] scheduled ${saved.id} for ${saved.at}`);
      } catch (err) {
        confirmations.push(`Couldn't schedule that: ${err.message}`);
      }
    }
    result = { ok: result.ok, text: `${cleaned}\n\n${confirmations.join('\n')}`.trim() };
  }

  await memory.appendTurn(channel, 'user', prompt);
  await memory.appendTurn(channel, 'assistant', result.text);
  return result;
}

// Handles a plain-English "tell X ..." / "dm X ..." request. Returns true if
// it fully handled the message (sent, or asked a clarifying question), false
// if it decided this wasn't really a send request after all.
async function tryHandleNaturalDm(message, { recipientText, messageText }) {
  const resolution = await resolveRecipient(message, recipientText);

  if (resolution.none) {
    await message.channel.send(
      `I don't know who "${recipientText}" is yet. @mention them once (or tell me their exact username) and I'll remember it for next time.`,
    );
    return true;
  }

  if (resolution.candidates) {
    const list = resolution.candidates.slice(0, 5).map((u) => `\`@${u.username}\``).join(', ');
    await message.channel.send(`A few people match "${recipientText}": ${list}. Which one?`);
    return true;
  }

  const { user } = resolution;
  try {
    await sendDM(client, user.id, messageText, { ownerName: OWNER_NAME });
    await contacts.learn(message.channel, recipientText, user.id, user.username);
    await message.channel.send(`Sent to **${user.globalName || user.username}**:\n> ${messageText}`);
  } catch (err) {
    await message.channel.send(`Couldn't message **${user.username}**. ${describeSendError(err)}`);
  }
  return true;
}

// Handles a plain-English "tell X on whatsapp ..." request. Returns true if
// it fully handled the message (sent, or asked a clarifying question).
async function tryHandleWhatsAppSend(message, { recipientText, messageText }) {
  const digits = recipientText.replace(/[^\d]/g, '');
  if (digits.length < 7) {
    const who = recipientText || 'them';
    await message.channel.send(`What's ${who}'s WhatsApp number? Include the country code (e.g. 923253697546).`);
    return true;
  }
  // Note: intentionally not stored in contacts.js - that store resolves Discord
  // users by fetching them via the Discord API, and a phone number would break
  // that path if it were ever looked up through the same alias resolver.
  try {
    await whatsapp.sendMessage(digits, messageText);
    await message.channel.send(`Sent on WhatsApp to **${digits}**:\n> ${messageText}`);
  } catch (err) {
    await message.channel.send(`Couldn't send that WhatsApp message: ${err.message}`);
  }
  return true;
}

async function respondWith(channel, text) {
  const body = text || '(empty response)';
  const chunks = body.match(/[\s\S]{1,1900}/g) || [body];
  for (const chunk of chunks) await channel.send(chunk);
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}. Active: ${currentProvider} / ${currentModelId}.`);
  // Reload reminders written before the last restart and restart the ticker.
  await reminders.resume(client, OWNER_ID);

  // Forward inbound WhatsApp straight to Discord, so work/university updates
  // land in one place without Huzaifa having to go looking for them.
  setWhatsAppHandler(async (payload) => {
    try {
      const owner = await client.users.fetch(OWNER_ID);
      const dm = await owner.createDM();
      const from = payload.senderName || payload.from || 'unknown';
      const chat = payload.chatName && payload.chatName !== from ? ` in ${payload.chatName}` : '';
      const body = String(payload.body || '').slice(0, 1500) || '(no text - media or attachment)';
      await dm.send(`**WhatsApp** from **${from}**${chat}:\n> ${body.replace(/\n/g, '\n> ')}`);
      console.log(`[whatsapp] forwarded message from ${from}`);
    } catch (err) {
      console.error('[whatsapp] failed to forward:', err.message);
    }
  });
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.user.id !== OWNER_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This bot is private.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // wcall / wmessage confirmation buttons and contact pickers
    if (interaction.isButton() || interaction.isStringSelectMenu()) {
      const handled = await waTriggers.handleInteraction(interaction);
      if (handled) return;
    }

    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'model') {
        await interaction.reply({
          content: `Currently: **${activeLabel()}**\nRunning on: ${whereItRuns()}\n\nPick a provider:`,
          components: [providerRow()],
        });
        return;
      }

      if (interaction.commandName === 'dm') {
        const target = interaction.options.getUser('user', true);
        const text = interaction.options.getString('message', true);
        await interaction.deferReply();
        try {
          await sendDM(client, target.id, text, { ownerName: OWNER_NAME });
          await interaction.editReply(`Sent to **${target.globalName || target.username}**:\n> ${text}`);
        } catch (err) {
          await interaction.editReply(`Couldn't message **${target.username}**. ${describeSendError(err)}`);
        }
        return;
      }

      if (interaction.commandName === 'agent') {
        const st = agentStatus();
        if (!st.online) {
          await interaction.reply(
            'Local agent: **offline**.\n' +
            'Right now I can only think, not act on your PC. Start `local-agent.js` on your machine ' +
            'to give Claude/ChatGPT/Gemini real shell, file and browser access.',
          );
          return;
        }
        await interaction.reply(
          `Local agent: **online**\n` +
          `Host: \`${st.host}\`\nPlatform: \`${st.platform}\`\n` +
          `Tools: ${st.tools.map((t) => `\`${t}\``).join(', ')}\n` +
          `Connected: ${st.connectedAt}`,
        );
        return;
      }

      if (interaction.commandName === 'status') {
        const pending = await reminders.list(interaction.channel);
        await interaction.reply(
          `Active: **${activeLabel()}**\n` +
          `Executing on: ${whereItRuns()}\n` +
          `Local agent: **${isAgentOnline() ? 'online' : 'offline'}**\n` +
          `Scheduled reminders: **${pending.length}**`,
        );
        return;
      }

      if (interaction.commandName === 'whatsapp') {
        if (!whatsapp.configured()) {
          await interaction.reply('WhatsApp is not wired up yet - set OPENWA_URL, OPENWA_API_KEY, and OPENWA_SESSION_ID.');
          return;
        }
        try {
          const s = await whatsapp.status();
          await interaction.reply(`WhatsApp session **${s.name || 'unknown'}** is **${s.status || 'unknown'}**${s.phone ? ` (${s.phone})` : ''}.`);
        } catch (err) {
          await interaction.reply(`Couldn't reach the WhatsApp gateway: ${err.message}`);
        }
        return;
      }

      if (interaction.commandName === 'reminders') {
        const cancelId = interaction.options.getString('cancel');
        if (cancelId) {
          const ok = await reminders.remove(interaction.channel, cancelId);
          await interaction.reply(ok ? `Cancelled \`${cancelId}\`.` : `No reminder with id \`${cancelId}\`.`);
          return;
        }
        const pending = await reminders.list(interaction.channel);
        if (!pending.length) {
          await interaction.reply('Nothing scheduled.');
          return;
        }
        await interaction.reply(
          `**Scheduled (${reminders.TZ}):**\n` +
          pending.map((r) => `\`${r.id}\`  ${reminders.formatLocal(r.at)}  -  ${r.text}`).join('\n') +
          '\n\n_Cancel one with_ `/reminders cancel:<id>`',
        );
        return;
      }

      if (interaction.commandName === 'help') {
        await interaction.reply(
          'DM me normally and I answer - no command needed.\n\n' +
          '`/model` - pick provider (Anthropic / OpenAI / Google / Aside) then a live model\n' +
          'Just say "tell morph I\'m running late" or "dm sarah: you around?" and I\'ll send it **as your assistant** - no /dm needed. ' +
          'I only ask before sending if I genuinely can\'t tell who you mean.\n' +
          '`/dm <user> <message>` - explicit fallback for the same thing\n' +
          '`/agent` - is the local agent on your PC connected?\n' +
          '`/status` - active model and where it runs\n\n' +
          'I remember our recent conversation and anything you tell me to remember, shared across every ' +
          'model - switching /model doesn\'t reset it. Say "remember that ..." to save something for good.\n\n' +
          'When the local agent is running, the LLMs get real tool access on your PC. ' +
          'When it is not, they run sandboxed on the server and can only talk.\n\n' +
          (whatsapp.configured()
            ? 'WhatsApp is connected (`/whatsapp` for status). Just mention "whatsapp" and ' +
              'I\'ll pull in recent chats, or say "tell <number> on whatsapp ..." to send.'
            : 'WhatsApp is not connected yet.'),
        );
        return;
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      if (id === 'model:provider') {
        const choice = interaction.values[0];
        if (!isValidProvider(choice)) {
          await interaction.update({ content: `Unknown provider "${choice}".`, components: [] });
          return;
        }
        if (!PROVIDERS[choice].bin) {
          currentProvider = choice;
          currentModelId = null;
          await interaction.update({
            content: `Switched to **${PROVIDERS[choice].label}**.\nI'll stay quiet here and let your Aside routine handle your DMs.`,
            components: [],
          });
          return;
        }
        await interaction.deferUpdate();
        let models;
        try {
          models = await getModels(choice);
        } catch (err) {
          await interaction.editReply({ content: `Couldn't load models for **${PROVIDERS[choice].label}**: ${err.message}`, components: [] });
          return;
        }
        if (!models.length) {
          await interaction.editReply({ content: `No models available for **${PROVIDERS[choice].label}**.`, components: [] });
          return;
        }
        await interaction.editReply({
          content: `**${PROVIDERS[choice].label}** - ${models.length} model(s) available. Pick one:`,
          components: [modelRow(choice, models)],
        });
        return;
      }

      if (id.startsWith('model:pick:')) {
        const providerKey = id.slice('model:pick:'.length);
        if (!isValidProvider(providerKey)) {
          await interaction.update({ content: 'That picker expired.', components: [] });
          return;
        }
        currentProvider = providerKey;
        currentModelId = interaction.values[0];
        await interaction.update({
          content: `Switched to **${activeLabel()}**.\nRunning on: ${whereItRuns()}`,
          components: [],
        });
        return;
      }
    }
  } catch (err) {
    console.error('interaction error:', err);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return;
  if (!message.content || !message.content.trim()) return;

  // --- someone who is NOT the owner DMed the assistant ---
  if (message.author.id !== OWNER_ID) {
    try {
      await forwardToOwner(client, OWNER_ID, message);
      console.log(`[relay] forwarded a DM from ${message.author.username}`);
    } catch (err) {
      console.error('[relay] failed to forward:', err.message);
    }
    return;
  }

  // --- owner replying to a forwarded message routes back to that friend ---
  const route = await resolveOwnerReply(message);
  if (route) {
    try {
      await sendDM(client, route.userId, message.content.trim(), { ownerName: OWNER_NAME });
      await message.react('\u2705').catch(() => {});
    } catch (err) {
      await message.reply(`Couldn't deliver that. ${describeSendError(err)}`);
    }
    return;
  }

  // --- wcall / wmessage trigger words ---
  // Checked before everything else so the trigger is unambiguous and never
  // gets swallowed by the looser natural-language intent matching below.
  const trigger = waTriggers.parseTrigger(message.content.trim());
  if (trigger) {
    try {
      const handled = await waTriggers.handleTrigger(message, trigger);
      if (handled) return;
    } catch (err) {
      console.error('[waTriggers] failed:', err);
      await message.channel.send(`That didn't work: ${err.message}`).catch(() => {});
      return;
    }
  }

  // --- explicit "remember that ..." shortcut, no LLM call needed ---
  const rememberMatch = message.content.trim().match(/^remember(?:\s+that)?[:\s]+(.+)$/i);
  if (rememberMatch) {
    await memory.addFact(message.channel, rememberMatch[1].trim());
    await message.react('\ud83e\udde0').catch(() => {});
    return;
  }

  // --- "send/tell X on whatsapp ..." - routes to the Oracle-hosted gateway ---
  const text = message.content.trim();
  if (/\bwhatsapp\b/i.test(text) && whatsapp.configured()) {
    const waRequest = parseDmRequest(text);
    if (waRequest) {
      const handled = await tryHandleWhatsAppSend(message, waRequest);
      if (handled) return;
    }
  }

  // --- "tell/dm/message someone something" in plain English, no /dm needed ---
  const dmRequest = parseDmRequest(text);
  if (dmRequest) {
    const handled = await tryHandleNaturalDm(message, dmRequest);
    if (handled) return;
    // Fell through (not actually a send request) - keep going to normal chat.
  }

  // --- normal assistant conversation ---
  if (!PROVIDERS[currentProvider] || !PROVIDERS[currentProvider].bin) return;

  await message.channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    const result = await think(message.channel, message.content.trim());
    await respondWith(message.channel, result.text);
  } catch (err) {
    console.error('[messageCreate] failed:', err);
    await message.channel.send(`Something went wrong: ${err.message}`).catch((e) => {
      console.error('[messageCreate] could not even send the error:', e.message);
    });
  } finally {
    clearInterval(typingInterval);
  }
});

// Heroku routes HTTP to the web dyno, so the bridge and the bot share one
// process. That also guarantees only one Discord gateway connection.
startBridge({
  port: process.env.PORT || 3000,
  secret: process.env.AGENT_SHARED_SECRET,
  whatsappWebhookSecret: process.env.WHATSAPP_WEBHOOK_SECRET,
});

client.login(process.env.DISCORD_TOKEN);
