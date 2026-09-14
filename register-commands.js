// Registers the bot's slash commands with Discord. Run this once after
// deploying (or whenever the command list changes): `npm run register-commands`.
const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { listModels } = require('./modelRunner');

const commands = [
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Switch which AI backend replies to your DMs')
    .addStringOption((opt) => {
      opt.setName('name').setDescription('Which model to use').setRequired(true);
      for (const m of listModels()) opt.addChoices({ name: m.label, value: m.key });
      return opt;
    }),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show which model is currently active and basic bot status'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show what this bot can do'),
].map((c) => c.toJSON());

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APPLICATION_ID;
  if (!token || !appId) {
    console.error('DISCORD_TOKEN and DISCORD_APPLICATION_ID must be set.');
    process.exit(1);
  }
  const rest = new REST({ version: '10' }).setToken(token);
  console.log('Registering global slash commands...');
  await rest.put(Routes.applicationCommands(appId), { body: commands });
  console.log('Done. Global commands can take up to an hour to show up everywhere (usually much faster).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
