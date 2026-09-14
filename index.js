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

setupCredentials();

// Hard allowlist: this bot only ever talks to one person (you). Reject
// everyone else even if they somehow DM it.
const OWNER_ID = process.env.OWNER_DISCORD_USER_ID || '845391729549115402';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// In-memory only - resets on dyno restart, which is fine for a single user.
let currentProvider = DEFAULT_PROVIDER;
let currentModelId = PROVIDERS[DEFAULT_PROVIDER].defaultModel;

function activeLabel() {
  const p = PROVIDERS[currentProvider];
  return currentModelId ? `${p.label} - \`${currentModelId}\`` : p.label;
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
      // Discord allows at most 25 options in a select menu.
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

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}. Active: ${currentProvider} / ${currentModelId}.`);
});

client.on('interactionCreate', async (interaction) => {
  try {
    const userId = interaction.user && interaction.user.id;
    if (userId !== OWNER_ID) {
      if (interaction.isRepliable()) {
        await interaction.reply({ content: 'This bot is private.', flags: MessageFlags.Ephemeral });
      }
      return;
    }

    // --- slash commands ---
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'model') {
        await interaction.reply({
          content: `Currently: **${activeLabel()}**\nPick a provider:`,
          components: [providerRow()],
        });
        return;
      }

      if (interaction.commandName === 'status') {
        await interaction.reply(
          `Active: **${activeLabel()}**\n` +
          `Use \`/model\` to switch provider and model.\n` +
          'Just DM me normally, no command needed.',
        );
        return;
      }

      if (interaction.commandName === 'help') {
        await interaction.reply(
          "Send me a normal DM and I'll reply - no command required.\n" +
          '`/model` - pick a provider (Anthropic / OpenAI / Google / Aside), then pick from its live model list\n' +
          '`/status` - show the active provider and model\n' +
          'On **Aside** the Heroku bot stays quiet and your Aside routine answers instead, using your real browser, Gmail, WhatsApp and university CMS.',
        );
        return;
      }
      return;
    }

    // --- select menus ---
    if (interaction.isStringSelectMenu()) {
      const id = interaction.customId;

      if (id === 'model:provider') {
        const choice = interaction.values[0];
        if (!isValidProvider(choice)) {
          await interaction.update({ content: `Unknown provider "${choice}".`, components: [] });
          return;
        }

        // Aside has no model list - select it directly.
        if (!PROVIDERS[choice].bin) {
          currentProvider = choice;
          currentModelId = null;
          await interaction.update({
            content: `Switched to **${PROVIDERS[choice].label}**.\nI'll stay quiet here and let your Aside routine handle your DMs.`,
            components: [],
          });
          return;
        }

        // Fetching a live model list can take a moment.
        await interaction.deferUpdate();
        let models;
        try {
          models = await getModels(choice);
        } catch (err) {
          await interaction.editReply({
            content: `Couldn't load models for **${PROVIDERS[choice].label}**: ${err.message}`,
            components: [],
          });
          return;
        }
        if (!models.length) {
          await interaction.editReply({
            content: `No models available for **${PROVIDERS[choice].label}**.`,
            components: [],
          });
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
          content: `Switched to **${activeLabel()}**. Just DM me normally, no command needed.`,
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
  if (message.channel.type !== ChannelType.DM) return; // DM-only bot
  if (message.author.id !== OWNER_ID) return; // hard allowlist
  if (!message.content || !message.content.trim()) return;

  // "aside" provider: stay completely silent. There is no CLI to run, and the
  // Aside event-driven routine answers these messages with real account access.
  if (!PROVIDERS[currentProvider] || !PROVIDERS[currentProvider].bin) return;

  await message.channel.sendTyping().catch(() => {});
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    const result = await runModel(currentProvider, currentModelId, message.content.trim());
    const text = result.text || '(empty response)';
    // Discord messages cap at 2000 chars - split long replies.
    const chunks = text.match(/[\s\S]{1,1900}/g) || [text];
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }
  } catch (err) {
    await message.channel.send(`Something went wrong: ${err.message}`);
  } finally {
    clearInterval(typingInterval);
  }
});

client.login(process.env.DISCORD_TOKEN);
