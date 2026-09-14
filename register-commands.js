// Registers the bot's slash commands with Discord.
// Run after deploying or whenever the command list changes.
//
// /model deliberately takes NO options - provider and model are chosen through
// select menus so the model list is fetched live at click time.
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('model')
    .setDescription('Pick which provider and model answers your DMs'),
  new SlashCommandBuilder()
    .setName('dm')
    .setDescription('Message one of your friends as your assistant, and relay their reply back to you')
    .addUserOption((o) => o.setName('user').setDescription('Who to message').setRequired(true))
    .addStringOption((o) => o.setName('message').setDescription('What to say').setRequired(true)),
  new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Check whether the local agent on your PC is connected'),
  new SlashCommandBuilder()
    .setName('reminders')
    .setDescription('List scheduled reminders, or cancel one')
    .addStringOption((o) => o.setName('cancel').setDescription('Reminder id to cancel').setRequired(false)),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show the active provider, model, and where it runs'),
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
