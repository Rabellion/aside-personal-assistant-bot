// Live call status + rolling transcript, rendered into a single Discord
// message that gets edited in place as the call progresses.
//
// The calling agent runs on EC2 and pushes events here through the bridge
// (`/call-event`). Nothing about the call is inferred locally - every state
// below comes from a real event emitted by the WhatsApp VoIP engine.

const active = new Map(); // jobId -> entry

const EDIT_THROTTLE_MS = 1200; // Discord rate-limits edits; coalesce bursts
const MAX_TRANSCRIPT_LINES = 14;
const MAX_LEN = 1900;

function register(jobId, { channel, message, name, phone, goal }) {
  active.set(jobId, {
    channel,
    message,
    name,
    phone,
    goal,
    status: 'dialing',
    endReason: null,
    sawRinging: false,
    answeredAt: null,
    lines: [],          // completed transcript lines
    current: null,      // { role, text } being streamed
    lastEditAt: 0,
    editTimer: null,
    done: false,
  });
  // Clean up long-abandoned entries (agent died without an `ended` event).
  for (const [k, v] of active) {
    if (v.done && Date.now() - v.lastEditAt > 10 * 60 * 1000) active.delete(k);
  }
}

function has(jobId) {
  return active.has(jobId);
}

/**
 * Human-readable status line.
 *
 * "Unreachable" is inferred from a real signal: the call ended without the
 * remote device ever reaching the ringing state, which is what happens when
 * their phone has no connectivity.
 */
function statusLine(e) {
  switch (e.status) {
    case 'dialing':
      return 'Dialing...';
    case 'ringing':
      return 'Ringing...';
    case 'connected':
      return 'Connected - talking now';
    case 'ended': {
      const r = String(e.endReason || '').toLowerCase();
      if (r === 'rejected') return 'Declined - they hit reject';
      if (r === 'busy' || r === 'active_elsewhere') return 'Busy - they were on another call';
      if (!e.sawRinging) return "Couldn't reach them - their phone looks offline or has no internet";
      if (r === 'timeout') return "No answer - it rang but they didn't pick up";
      if (e.answeredAt) {
        if (r.startsWith('goal_complete')) return 'Finished - the assistant wrapped up the call';
        if (r.startsWith('max_duration')) return 'Ended - hit the time limit';
        return 'Call ended';
      }
      return `Ended (${e.endReason || 'unknown'})`;
    }
    default:
      return e.status;
  }
}

function fmtPhone(phone) {
  const d = String(phone || '');
  if (d.length === 12 && d.startsWith('92')) return `+92 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return d ? `+${d}` : '';
}

function render(e) {
  const who = e.name ? `**${e.name}**` : `**${fmtPhone(e.phone)}**`;
  const num = e.name ? ` (${fmtPhone(e.phone)})` : '';
  const head = `**Call** to ${who}${num}\n**Status:** ${statusLine(e)}`;
  const goal = e.goal ? `\n> ${e.goal}` : '';

  const all = [...e.lines];
  if (e.current && e.current.text.trim()) all.push(e.current);
  if (!all.length) return `${head}${goal}`;

  const shown = all.slice(-MAX_TRANSCRIPT_LINES);
  const body = shown
    .map((l) => `${l.role === 'ai' ? 'Assistant' : 'Them'}: ${l.text.trim()}`)
    .join('\n');

  let out = `${head}${goal}\n\n**Transcript**\n${body}`;
  if (out.length > MAX_LEN) out = `${out.slice(0, MAX_LEN - 3)}...`;
  return out;
}

async function flush(jobId, { immediate = false } = {}) {
  const e = active.get(jobId);
  if (!e || !e.message) return;

  const since = Date.now() - e.lastEditAt;
  if (!immediate && since < EDIT_THROTTLE_MS) {
    // Coalesce: schedule one trailing edit instead of spamming the API.
    if (!e.editTimer) {
      e.editTimer = setTimeout(() => {
        e.editTimer = null;
        flush(jobId, { immediate: true }).catch(() => {});
      }, EDIT_THROTTLE_MS - since);
    }
    return;
  }

  if (e.editTimer) { clearTimeout(e.editTimer); e.editTimer = null; }
  e.lastEditAt = Date.now();
  try {
    await e.message.edit(render(e));
  } catch (err) {
    console.error('[callLive] edit failed:', err.message);
  }
}

/** Accumulate streamed transcript fragments into readable lines. */
function appendTranscript(e, role, fragment) {
  const text = String(fragment || '');
  if (!text) return;
  if (!e.current || e.current.role !== role) {
    if (e.current && e.current.text.trim()) e.lines.push(e.current);
    e.current = { role, text: '' };
  }
  // Gemini streams deltas that already carry their own leading spaces.
  e.current.text += text;
  if (e.lines.length > 200) e.lines.splice(0, e.lines.length - 200);
}

/** Handle one event pushed from the calling agent. */
async function onEvent(evt) {
  const jobId = evt && evt.jobId;
  if (!jobId) return;
  const e = active.get(jobId);
  if (!e) return; // not a call we started from Discord

  switch (evt.type) {
    case 'ringing':
      e.sawRinging = true;
      e.status = 'ringing';
      await flush(jobId, { immediate: true });
      break;

    case 'connected':
      e.status = 'connected';
      e.answeredAt = Date.now();
      await flush(jobId, { immediate: true });
      break;

    case 'transcript':
      appendTranscript(e, evt.role === 'peer' ? 'peer' : 'ai', evt.text);
      await flush(jobId);
      break;

    case 'ended':
      e.status = 'ended';
      e.endReason = evt.reason || null;
      e.done = true;
      if (e.current && e.current.text.trim()) { e.lines.push(e.current); e.current = null; }
      await flush(jobId, { immediate: true });
      break;

    default:
      break;
  }
}

module.exports = { register, has, onEvent, render, statusLine };
