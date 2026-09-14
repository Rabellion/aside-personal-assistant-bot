const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const { setupCredentials } = require('./credentials');
const { MODELS, DEFAULT_MODEL, isValidModel, listModels, runModel } = require('./modelRunner');

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

// In-memory only - resets on dyno restart. Fine for a single-user bot;
// defaults back to DEFAULT_MODEL after a restart.
let currentModel = DEFAULT_MODEL;

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}. Active model: ${currentModel}.`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({ content: "This bot is private.", ephemeral: true });
    return;
  }

  if (interaction.commandName === 'model') {
    const choice = interaction.options.getString('name', true);
    if (!isValidModel(choice)) {
      await interaction.reply({ content: `Unknown model "${choice}".`, ephemeral: true });
      return;
    }
    currentModel = choice;
    await interaction.reply(`Switched to **${MODELS[choice].label}**. Just DM me normally, no command needed.`);
    return;
  }

  if (interaction.commandName === 'status') {
    await interaction.reply(
      `Active model: **${MODELS[currentModel].label}**\n` +
      `Available: ${listModels().map((m) => `\`${m.key}\``).join(', ')}\n` +
      `Just DM me like a normal chat, no command needed - use \`/model\` to switch backends.`
    );
    return;
  }

  if (interaction.commandName === 'help') {
    await interaction.reply(
      "Just send me a normal DM and I'll reply - no command required.\n" +
      "`/model <name>` - switch between Claude / ChatGPT / Gemini\n" +
      "`/status` - see which model is active\n" +
      "For your Aside-integrated schedule and anything needing your Gmail/WhatsApp/university CMS, that's handled separately by your Aside routines in this same DM."
    );
    return;
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.DM) return; // DM-only bot
  if (message.author.id !== OWNER_ID) return; // hard allowlist
  if (!message.content || !message.content.trim()) return;

  await message.channel.sendTyping().catch(() => {});
  // Keep the typing indicator alive for slower models.
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);

  try {
    const result = await runModel(currentModel, message.content.trim());
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
