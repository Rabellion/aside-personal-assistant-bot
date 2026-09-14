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
const { startBridge, dispatchToAgent, isAgentOnline, agentStatus } = require('./bridge');
const contacts = require('./contacts');
const memory = require('./memory');
const { parseDmRequest, resolveRecipient } = require('./dmIntent');

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
async function think(channel, prompt) {
  await memory.load(channel);
  const context = memory.buildContext();
  const fullPrompt = context ? `${context}Huzaifa just said: ${prompt}` : prompt;

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
      // If the PC run failed, still try the dyno so the user gets *something*.
      const fallback = await runModel(currentProvider, currentModelId, fullPrompt);
      result = fallback.ok
        ? { ok: true, text: `${fallback.text}\n\n_(local agent failed, answered from the server instead: ${res.text.slice(0, 200)})_` }
        : res;
    }
  } else {
    result = await runModel(currentProvider, currentModelId, fullPrompt);
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

async function respondWith(channel, text) {
  const body = text || '(empty response)';
  const chunks = body.match(/[\s\S]{1,1900}/g) || [body];
  for (const chunk of chunks) await channel.send(chunk);
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}. Active: ${currentProvider} / ${currentModelId}.`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.user.id !== OWNER_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This bot is private.', flags: MessageFlags.Ephemeral });
      }
      return;
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
        await interaction.reply(
          `Active: **${activeLabel()}**\n` +
          `Executing on: ${whereItRuns()}\n` +
          `Local agent: **${isAgentOnline() ? 'online' : 'offline'}**`,
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
          'When it is not, they run sandboxed on the server and can only talk.',
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

  // --- explicit "remember that ..." shortcut, no LLM call needed ---
  const rememberMatch = message.content.trim().match(/^remember(?:\s+that)?[:\s]+(.+)$/i);
  if (rememberMatch) {
    await memory.addFact(message.channel, rememberMatch[1].trim());
    await message.react('\ud83e\udde0').catch(() => {});
    return;
  }

  // --- "tell/dm/message someone something" in plain English, no /dm needed ---
  const dmRequest = parseDmRequest(message.content.trim());
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
    await message.channel.send(`Something went wrong: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
  }
});

// Heroku routes HTTP to the web dyno, so the bridge and the bot share one
// process. That also guarantees only one Discord gateway connection.
startBridge({
  port: process.env.PORT || 3000,
  secret: process.env.AGENT_SHARED_SECRET,
});

client.login(process.env.DISCORD_TOKEN);
