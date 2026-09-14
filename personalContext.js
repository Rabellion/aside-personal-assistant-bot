// Reads everything Aside knows about Huzaifa straight from Aside's own memory
// directory on his PC, and feeds it to whichever CLI is answering.
//
// Deliberately NOT cached. Every task re-reads from disk, so editing any of
// these .md files takes effect on the very next message - no restart, no sync
// step, no stale copy living on Heroku. That also means his personal data
// never leaves his machine: the Heroku dyno never sees these files, only the
// local agent does.
//
// Override the location with ASIDE_MEMORY_DIR if the profile ever moves.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MEMORY_DIR = process.env.ASIDE_MEMORY_DIR || path.join(os.homedir(), '.aside', 'u', '0', 'memory');
const ACCOUNT_DIR = path.dirname(MEMORY_DIR);

// Total budget for the whole personal-context block. Generous enough for the
// full profile, bounded so a runaway episodic log can't blow up the prompt.
const TOTAL_BUDGET = 48000;
const EPISODIC_BUDGET = 6000;

function readIfExists(file, budget) {
  try {
    if (!fs.existsSync(file)) return null;
    let text = fs.readFileSync(file, 'utf8').trim();
    if (!text) return null;
    // Strip HTML comment scaffolding that template files ship with.
    text = text.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!text) return null;
    if (budget && text.length > budget) {
      // Keep the TAIL of episodic logs - most recent entries matter most.
      text = `...(truncated)...\n${text.slice(-budget)}`;
    }
    return text;
  } catch (_) {
    return null;
  }
}

function listUserProfiles() {
  const dir = path.join(MEMORY_DIR, 'users');
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => path.join(dir, f));
  } catch (_) {
    return [];
  }
}

function newestEpisodic() {
  const dir = path.join(MEMORY_DIR, 'episodic');
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    return files.length ? path.join(dir, files[files.length - 1]) : null;
  } catch (_) {
    return null;
  }
}

// Returns a formatted context block, or '' if Aside's memory isn't reachable
// (e.g. the agent is running on a different machine).
function buildPersonalContext() {
  const sections = [];

  const soul = readIfExists(path.join(ACCOUNT_DIR, 'SOUL.md'));
  if (soul) sections.push(`## Your persona and tone\n${soul}`);

  const briefing = readIfExists(path.join(MEMORY_DIR, 'USER.md'));
  if (briefing) sections.push(`## Who Huzaifa is (quick briefing)\n${briefing}`);

  const operating = readIfExists(path.join(MEMORY_DIR, 'MEMORY.md'));
  if (operating) sections.push(`## Operating defaults\n${operating}`);

  for (const p of listUserProfiles()) {
    const profile = readIfExists(p);
    if (profile) sections.push(`## Full profile (${path.basename(p)})\n${profile}`);
  }

  const ep = newestEpisodic();
  if (ep) {
    const recent = readIfExists(ep, EPISODIC_BUDGET);
    if (recent) sections.push(`## Recent activity log (${path.basename(ep)})\n${recent}`);
  }

  if (!sections.length) return '';

  let block = sections.join('\n\n');
  if (block.length > TOTAL_BUDGET) block = `${block.slice(0, TOTAL_BUDGET)}\n...(truncated)...`;

  return [
    '=== WHAT YOU KNOW ABOUT HUZAIFA ===',
    'This is read live from his Aside memory on every message, so it is always current.',
    'Use it to answer as someone who already knows him: his details, his accounts, his',
    'commitments and how he talks. Match the tone guidance rather than sounding generic.',
    'Do not recite this back at him or mention that you were given context.',
    '',
    block,
    '=== END ===',
    '',
  ].join('\n');
}

module.exports = { buildPersonalContext, MEMORY_DIR };
