/**
 * What the agent should do after each error code. Companion's own messages
 * name the next step; this is the net under them for an older Companion, or
 * any path that still sends a bare code, so an error is never a dead end.
 */

export const NEXT_ACTION: Readonly<Record<string, string>> = {
  rate_limited: 'Wait a minute, then retry.',
  cooling_down: 'Wait a few minutes before asking again.',
  paused: 'The user is talking to Companion; wait a few seconds, then retry.',
  // Companion uses busy for two waits: another agent holding the hands, or a sheet open on the Mac.
  busy:
    "Either another agent holds Companion's hands (ask the user to close that session) or an approval " +
    'sheet is open on the Mac (ask the user to answer it), then retry.',
  no_session: 'Send hello, then retry.',
  session_closed: 'Send hello again to open a new approval sheet on the Mac, then retry.',
  target_changed: 'Call look to see what is in front now, then retry.',
  stale_id: 'Call look for fresh ids, then retry.',
  secure_field: 'Ask the user to type it themselves.',
  needs_accessibility:
    'Ask the user to turn on Companion in System Settings > Privacy & Security > Accessibility, then retry.',
  screen_recording_required:
    'Ask the user to turn on Companion in System Settings > Privacy & Security > Screen & System Audio Recording, then retry.',
  permission_required:
    'Ask the user to turn on the permission named above in System Settings > Privacy & Security, then retry.',
  screen_locked: 'Ask the user to unlock the Mac, then call look before retrying.',
  foreground_unavailable: 'Call look before retrying.',
  self_in_front: 'Ask the user to switch to the app to act on, or call open_app, then retry.',
  denied_by_user: 'The user said no: ask them before trying this again.',
  approval_timeout: 'Nobody answered the approval sheet: ask the user before trying again.',
  timeout: 'If it was an action, call look to check whether it happened before retrying.',
  not_connected: 'Ask the user to open the browser with the Companion extension on, then retry.',
  invalid_args: 'Fix the arguments the message names, then retry.',
};

// Per code, the wording that means the message already gave this step, so ours would say it twice.
// A code with no entry always gets its hint: those refusals protect the user, and screen text that
// reaches the message must not be able to drop them by containing a word like "retry".
const ALREADY_SAID: Readonly<Record<string, RegExp>> = {
  rate_limited: /\b(wait|retry)\b/i,
  cooling_down: /\bwait\b|before asking again/i,
  paused: /\b(wait|retry)\b/i,
  busy: /\bthen retry\b|send hello again/i,
  no_session: /send hello|ask the user/i,
  session_closed: /send hello|ask the user/i,
  target_changed: /\bcall look\b|\blook again\b|\bthen retry\b/i,
  stale_id: /\blook again\b|\bcall look\b/i,
  // Only the pane itself counts: "ask the user" without it is the vague message the net is for.
  needs_accessibility: /System Settings > Privacy & Security > /,
  screen_recording_required: /System Settings > Privacy & Security > /,
  // The shim also raises this code for bridge files it may not open, with its own way out.
  permission_required: /System Settings > Privacy & Security > |\bthen retry\b/i,
  screen_locked: /\bunlock\b/i,
  foreground_unavailable: /\bcall look\b/i,
  self_in_front: /\bto the front\b|\bopen_app\b/i,
  timeout: /\bcall look\b|\blook before\b/i,
  not_connected: /\bextension\b/i,
  invalid_args: /\bretry\b|\bsend one\b/i,
};

export function withNextAction(code: string, message: string): string {
  const hint = NEXT_ACTION[code];
  if (!hint || ALREADY_SAID[code]?.test(message)) return message;
  if (message.length === 0) return hint;
  return /[.!?]$/.test(message) ? `${message} ${hint}` : `${message}. ${hint}`;
}
