// Two-way DM relay.
//
// Outbound: Huzaifa asks the assistant to message a friend -> the bot DMs that
// friend *as the assistant*, never pretending to be Huzaifa.
// Inbound: the friend replies to the bot -> the bot forwards it to Huzaifa and
// remembers who said it, so Huzaifa can just hit Discord's reply button on the
// forwarded message to answer without typing any command.
//
// HARD DISCORD LIMIT: a bot can only open a DM with a user who shares a server
// with it. If the friend isn't in a server the bot is in, Discord returns
// 403 "Cannot send messages to this user" and there is no way around it short
// of the friend joining a shared server.

const { ChannelType } = require('discord.js');

// forwardedMessageId -> { userId, username }
// Lets "reply to the forwarded message" work with no command.
const replyRoutes = new Map();
// Most recent person who messaged us, so a bare /reply works too.
let lastInbound = null;
const MAX_ROUTES = 500;

function rememberRoute(forwardedMessageId, userId, username) {
  if (replyRoutes.size >= MAX_ROUTES) {
    const oldest = replyRoutes.keys().next().value;
    replyRoutes.delete(oldest);
  }
  replyRoutes.set(forwardedMessageId, { userId, username });
  lastInbound = { userId, username };
}

function getRoute(forwardedMessageId) {
  return replyRoutes.get(forwardedMessageId) || null;
}

function getLastInbound() {
  return lastInbound;
}

// The assistant identifies itself so the friend is never misled into thinking
// they're talking to Huzaifa directly.
function signature(ownerName) {
  return `\n\n_- ${ownerName}'s assistant_`;
}

async function sendDM(client, userId, content, { ownerName, sign = true } = {}) {
  const user = await client.users.fetch(userId);
  const dm = await user.createDM();
  const body = sign ? `${content}${signature(ownerName)}` : content;
  const chunks = body.match(/[\s\S]{1,1900}/g) || [body];
  let first = null;
  for (const chunk of chunks) {
    const sent = await dm.send(chunk);
    if (!first) first = sent;
  }
  return { user, message: first };
}

function describeSendError(err) {
  // 50007 = "Cannot send messages to this user". This fires for two different
  // reasons that look identical from the API: (1) the bot doesn't share any
  // server with them, or (2) it does, but they have "Allow direct messages
  // from server members" turned off for that server (Privacy Settings, per
  // server). Sharing a server is necessary but not sufficient.
  if (err && (err.code === 50007 || /cannot send messages to this user/i.test(err.message || ''))) {
    return (
      "Discord blocked it (error 50007). Two possible causes: either we don't share a server yet, " +
      'or we do but they have DMs from server members turned off for that server ' +
      '(their Privacy Settings, not something I can change). If you already added me to a shared server ' +
      'and this still happens, ask them to enable "Allow direct messages from server members" for it.'
    );
  }
  if (err && err.code === 10013) return "That user ID doesn't exist.";
  return `Discord rejected it: ${err.message}`;
}

// Forward an inbound DM from a non-owner to the owner.
async function forwardToOwner(client, ownerId, message) {
  const owner = await client.users.fetch(ownerId);
  const dm = await owner.createDM();
  const author = message.author;
  const name = author.globalName || author.username;

  let body = `**${name}** (\`@${author.username}\`) messaged me:\n> ${message.content.replace(/\n/g, '\n> ')}`;
  if (message.attachments && message.attachments.size) {
    body += `\n\n_attachments:_ ${[...message.attachments.values()].map((a) => a.url).join(' ')}`;
  }
  body += '\n\n_Reply to this message and I\'ll send it back to them._';

  const forwarded = await dm.send(body);
  rememberRoute(forwarded.id, author.id, author.username);
  return forwarded;
}

// Is this owner message a reply to something we forwarded?
async function resolveOwnerReply(message) {
  const ref = message.reference;
  if (!ref || !ref.messageId) return null;
  const route = getRoute(ref.messageId);
  if (route) return route;

  // The map is in-memory and resets on dyno restart. Fall back to re-parsing
  // the message we replied to, which still carries the @username.
  try {
    const original = await message.channel.messages.fetch(ref.messageId);
    if (!original || !original.author.bot) return null;
    const m = original.content.match(/\(`@([^`]+)`\) messaged me:/);
    if (!m) return null;
    const username = m[1];
    const found = original.client.users.cache.find((u) => u.username === username);
    if (found) return { userId: found.id, username };
  } catch (_) {
    /* ignore */
  }
  return null;
}

module.exports = {
  sendDM,
  forwardToOwner,
  resolveOwnerReply,
  describeSendError,
  getLastInbound,
  rememberRoute,
  ChannelType,
};
