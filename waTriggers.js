// `wcall` / `wmessage` trigger words.
//
//   wcall aden ask if the exam is tomorrow
//   wmessage abdul ahad running 10 mins late
//   wcall 923556418183 remind them about the meeting
//
// A name is resolved against the real WhatsApp address book. Nothing is ever
// sent or dialled on a guess: one match asks for confirmation, several offer
// a picker, none asks for a number. Calling someone by mistake is a lot more
// intrusive than a wrong chat message, so both paths confirm.

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');

const waContacts = require('./waContacts');
const whatsapp = require('./whatsapp');
const voiceCall = require('./voiceCall');
const callLive = require('./callLive');

// Pending confirmations, keyed by a short token embedded in the customId.
// Discord caps customId at 100 chars, so the payload lives here, not there.
const pending = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function putPending(data) {
  const token = Math.random().toString(36).slice(2, 10);
  pending.set(token, { ...data, at: Date.now() });
  // opportunistic sweep
  for (const [k, v] of pending) if (Date.now() - v.at > PENDING_TTL_MS) pending.delete(k);
  return token;
}

function takePending(token) {
  const v = pending.get(token);
  if (!v) return null;
  pending.delete(token);
  if (Date.now() - v.at > PENDING_TTL_MS) return null;
  return v;
}

/**
 * `wcall <who> <body>` / `wmessage <who> <body>`
 *
 * There's no delimiter between the name and the message, and names run 1-3
 * words ("Snake CR", "Abdul Ahad"). Guessing a fixed length here is wrong -
 * "wcall aden ask if the exam is tomorrow" would read the name as "aden ask
 * if". So this returns every plausible name/body split and lets the caller
 * decide using the real address book.
 */
function parseTrigger(text) {
  const m = String(text || '').trim().match(/^(wcall|wmessage)\s+([\s\S]+)$/i);
  if (!m) return null;
  const kind = m[1].toLowerCase() === 'wcall' ? 'call' : 'message';
  const rest = m[2].trim();
  if (!rest) return null;

  // A leading phone number is unambiguous - take it and treat the rest as body.
  const phoneFirst = rest.match(/^(\+?\d[\d\s-]{6,17}\d)\s+([\s\S]+)$/);
  if (phoneFirst) {
    return { kind, who: phoneFirst[1].replace(/[^\d]/g, ''), body: phoneFirst[2].trim(), isPhone: true };
  }

  const words = rest.split(/\s+/);
  const candidates = [];
  for (const take of [3, 2, 1]) {
    if (words.length <= take) continue;
    candidates.push({ who: words.slice(0, take).join(' '), body: words.slice(take).join(' ').trim() });
  }
  if (!candidates.length) return null;
  return { kind, candidates, isPhone: false };
}

function actionVerb(kind) {
  return kind === 'call' ? 'Call' : 'Message';
}

/**
 * Runs the confirmed action.
 *
 * For calls this returns a placeholder message that `callLive` then edits in
 * place as real events arrive (ringing / answered / declined / transcript),
 * so the Discord message doubles as a live call view.
 */
async function executeAction({ kind, phone, name, body }, channel) {
  if (kind === 'call') {
    const job = await voiceCall.placeCall({ to: phone, goal: body, name });
    const who = name ? `**${name}**` : `**${waContacts.formatPhone(phone)}**`;
    const num = name ? ` (${waContacts.formatPhone(phone)})` : '';
    const card = await channel.send(`**Call** to ${who}${num}\n**Status:** Dialing...\n> ${body}`);
    callLive.register(job.jobId, { channel, message: card, name, phone, goal: body });
    return null; // the live card is the response
  }
  await whatsapp.sendMessage(phone, body);
  return `Sent on WhatsApp to **${name || phone}** (${waContacts.formatPhone(phone)}):\n> ${body}`;
}

/**
 * Entry point from messageCreate. Returns true if this message was a trigger
 * and has been fully handled.
 */
async function handleTrigger(message, parsed) {
  const { kind, isPhone } = parsed;

  if (kind === 'call' && !voiceCall.configured()) {
    await message.channel.send('Voice calling is not configured yet (CALL_API_URL / CALL_API_KEY).');
    return true;
  }
  if (!whatsapp.configured()) {
    await message.channel.send('WhatsApp is not configured yet.');
    return true;
  }

  // Explicit number: still confirm, but there is nothing to resolve.
  if (isPhone) {
    const token = putPending({ kind, phone: parsed.who, name: null, body: parsed.body });
    await message.channel.send({
      content: `${actionVerb(kind)} **${waContacts.formatPhone(parsed.who)}**?\n> ${parsed.body}`,
      components: [confirmRow(token)],
    });
    return true;
  }

  // Score every name/body split against the address book and keep the best
  // real match. Ties prefer the longer name, so "snake cr" wins over "snake".
  let best = null;
  try {
    for (const cand of parsed.candidates) {
      const found = await waContacts.search(cand.who);
      if (!found.length) continue;
      const top = found[0]._score;
      const nameWords = cand.who.split(/\s+/).length;
      if (!best || top > best.top || (top === best.top && nameWords > best.nameWords)) {
        best = { ...cand, matches: found, top, nameWords };
      }
    }
  } catch (err) {
    await message.channel.send(`Couldn't read your WhatsApp contacts: ${err.message}`);
    return true;
  }

  if (!best) {
    const guess = parsed.candidates[parsed.candidates.length - 1];
    await message.channel.send(
      `No WhatsApp contact matches **${guess.who}**. Either it's saved under a different name, or give me the number directly:\n\`\`\`\n${kind === 'call' ? 'wcall' : 'wmessage'} 923001234567 ${guess.body}\n\`\`\``,
    );
    return true;
  }

  const who = best.who;
  const body = best.body;
  const matches = best.matches;

  // Exactly one clear match -> simple yes/no.
  if (matches.length === 1) {
    const c = matches[0];
    const token = putPending({ kind, phone: c.phone, name: c.name, body });
    await message.channel.send({
      content: `${actionVerb(kind)} **${c.name}** (${waContacts.formatPhone(c.phone)})?\n> ${body}`,
      components: [confirmRow(token)],
    });
    return true;
  }

  // Several candidates -> let him pick which one.
  const token = putPending({ kind, body, options: matches.map((c) => ({ phone: c.phone, name: c.name })) });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`wa:pick:${token}`)
    .setPlaceholder(`Which "${who}"?`)
    .addOptions(
      matches.slice(0, 25).map((c) => ({
        label: c.name.slice(0, 100),
        description: waContacts.formatPhone(c.phone),
        value: c.phone,
      })),
    );

  await message.channel.send({
    content: `${matches.length} contacts match **${who}** - which one should I ${kind === 'call' ? 'call' : 'message'}?\n> ${body}`,
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`wa:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      ),
    ],
  });
  return true;
}

function confirmRow(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wa:go:${token}`).setLabel('Confirm').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wa:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
}

/** Routes wa:* component interactions. Returns true if it handled one. */
async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('wa:')) return false;

  const [, action, token] = id.split(':');
  const data = takePending(token);

  if (!data) {
    await interaction.update({ content: 'That request expired - send it again.', components: [] }).catch(() => {});
    return true;
  }

  if (action === 'cancel') {
    await interaction.update({ content: 'Cancelled, nothing sent.', components: [] }).catch(() => {});
    return true;
  }

  if (action === 'pick') {
    const phone = interaction.values && interaction.values[0];
    const chosen = (data.options || []).find((o) => o.phone === phone);
    if (!chosen) {
      await interaction.update({ content: "That option isn't valid any more.", components: [] }).catch(() => {});
      return true;
    }
    await interaction.update({ content: `Working on it - ${data.kind === 'call' ? 'calling' : 'messaging'} **${chosen.name}**...`, components: [] }).catch(() => {});
    try {
      const msg = await executeAction(
        { kind: data.kind, phone: chosen.phone, name: chosen.name, body: data.body },
        interaction.channel,
      );
      if (msg) await interaction.followUp(msg);
    } catch (err) {
      await interaction.followUp(`That didn't work: ${err.message}`);
    }
    return true;
  }

  if (action === 'go') {
    await interaction.update({ content: `Working on it - ${data.kind === 'call' ? 'calling' : 'messaging'} **${data.name || data.phone}**...`, components: [] }).catch(() => {});
    try {
      const msg = await executeAction(data, interaction.channel);
      if (msg) await interaction.followUp(msg);
    } catch (err) {
      await interaction.followUp(`That didn't work: ${err.message}`);
    }
    return true;
  }

  return false;
}

module.exports = { parseTrigger, handleTrigger, handleInteraction };
