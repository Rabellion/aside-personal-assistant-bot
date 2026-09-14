// Detects "message/dm/tell someone something" requests from plain English, so
// Huzaifa never has to type /dm. /dm still exists as an explicit fallback.
//
// Two jobs:
//   1. parseDmRequest(text)      -> { recipientText, messageText } | null
//   2. resolveRecipient(...)     -> a Discord user, using (in priority order)
//      an @mention in the message, the learned contacts book, then a live
//      guild member search.

const VERBS = '(?:dm|message|text|msg|ping)';
const TELL_VERBS = '(?:tell|ask)';
const FILLER = /\b(please|could you|can you|would you|hey|so|via discord|on discord|to (?:his|her|their) dms?|to (?:his|her|their) discord|discord dm)\b/gi;

function stripQuotes(s) {
  return s.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim();
}

// Pulls { recipientText, messageText } out of a natural sentence, or null if
// this doesn't look like a send-a-message request at all.
function parseDmRequest(raw) {
  const text = raw.trim();
  if (!text) return null;

  // Quoted message wins regardless of surrounding phrasing:
  // send morph "he is gae"  |  tell morph he is annoying, saying "..."
  const quoted = text.match(/["“]([^"”]{1,1800})["”]/);

  // Pattern A: <verb> <recipient> [connector] [message]
  //   dm/message/text/msg/ping X (that|saying|:|-) Y
  const a = text.match(
    new RegExp(`\\b${VERBS}\\s+(?:my friend\\s+)?([\\w. ]{2,32}?)\\s*(?:that says|saying|telling (?:him|her|them)(?: that)?|:|-)?\\s*(.+)$`, 'is'),
  );
  // Pattern B: tell/ask <recipient> [that] <message>
  const b = text.match(
    new RegExp(`\\b${TELL_VERBS}\\s+(?:my friend\\s+)?([\\w. ]{2,32}?)\\s*(?:that|to say|saying)?\\s*[:\\-]?\\s*(.+)$`, 'is'),
  );
  // Pattern C: send <recipient> a message (on discord) (saying|that says) <message>
  const c = text.match(
    new RegExp(`\\bsend\\s+(?:my friend\\s+)?([\\w. ]{2,32}?)\\s+an?\\s+(?:message|msg|dm|text)\\b.*?(?:saying|that says|telling (?:him|her|them)(?: that)?|:)\\s*(.+)$`, 'is'),
  );

  const m = c || a || b;
  if (!m) return null;

  let recipientText = m[1];
  let messageText = quoted ? quoted[1] : m[2];
  if (!recipientText || !messageText) return null;

  recipientText = recipientText.replace(FILLER, ' ').replace(/\s+/g, ' ').trim();
  messageText = stripQuotes(messageText.replace(FILLER, ' ').replace(/\s+send it.*$/i, '').trim());

  if (!recipientText || !messageText) return null;
  // Guard against false positives like "text me back" matching as a send.
  if (/^(me|myself|you|yourself)$/i.test(recipientText)) return null;

  return { recipientText, messageText };
}

// Returns { user } on a confident single match, { candidates } when
// ambiguous, or { none: true } when nobody matched.
async function resolveRecipient(message, recipientText) {
  const contacts = require('./contacts');

  // 1. An explicit @mention in the original message always wins.
  const mentioned = message.mentions.users.first();
  if (mentioned) return { user: mentioned };

  // 2. Known contact alias.
  await contacts.load(message.channel);
  const known = contacts.findByAlias(recipientText);
  if (known) {
    try {
      const user = await message.client.users.fetch(known.userId);
      return { user };
    } catch (_) {
      /* fall through to a fresh search */
    }
  }

  // 3. Live search across guilds the bot shares with Huzaifa. Discord's
  // search endpoint only prefix-matches, so "morph" won't find a username
  // like "callmemorph." - fall back to a full member fetch + substring match
  // for any guild small enough that this is cheap.
  const seen = new Map();
  const needle = recipientText.toLowerCase();
  for (const guild of message.client.guilds.cache.values()) {
    try {
      const results = await guild.members.search({ query: recipientText, limit: 5 });
      for (const member of results.values()) seen.set(member.id, member.user);
    } catch (err) {
      console.log(`[dmIntent] member search failed in ${guild.name}:`, err.message);
    }

    if (seen.size === 0 && guild.memberCount && guild.memberCount <= 1000) {
      try {
        const all = await guild.members.fetch();
        for (const member of all.values()) {
          const haystacks = [member.user.username, member.user.globalName, member.nickname].filter(Boolean).map((s) => s.toLowerCase());
          if (haystacks.some((h) => h.includes(needle) || needle.includes(h))) {
            seen.set(member.id, member.user);
          }
        }
      } catch (err) {
        console.log(`[dmIntent] full member fetch failed in ${guild.name}:`, err.message);
      }
    }
  }

  const candidates = [...seen.values()];
  if (candidates.length === 0) return { none: true };
  if (candidates.length === 1) return { user: candidates[0] };

  // Prefer an exact (case-insensitive) username/global-name match among the
  // candidates before asking Huzaifa to disambiguate.
  const exact = candidates.find(
    (u) => u.username.toLowerCase() === recipientText.toLowerCase() || (u.globalName || '').toLowerCase() === recipientText.toLowerCase(),
  );
  if (exact) return { user: exact };

  return { candidates };
}

module.exports = { parseDmRequest, resolveRecipient };
