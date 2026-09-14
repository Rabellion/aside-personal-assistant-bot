// Registers the bot's slash commands with Discord. Run this once after
// deploying (or whenever the command list changes): `npm run register-commands`.
//
// /model deliberately takes NO options. Picking a provider and a model happens
// through select menus so the model list can be fetched live at click time
// instead of being frozen into the command definition.
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Pick which provider and model answers your DMs'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the active provider and model'),
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
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
