/**
 * Which bridge tools act and which only read, mirroring Companion's own buckets
 * (BridgePolicy.writeTools and readTools). One list for the timeouts and the annotations: two
 * lists drifted apart and the browser actions were timed and annotated as reads.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'click',
  'type_text',
  'press_key',
  'scroll',
  'menu',
  'open_app',
  'open_url',
  'open_file',
  'browser_click',
  'browser_double_click',
  'browser_right_click',
  'browser_scroll',
  'browser_hover',
  'browser_type',
  'browser_select',
  'browser_navigate',
  'browser_press',
  'browser_open',
  'browser_take',
  'browser_release',
  'companion_ask',
  'companion_new_conversation',
  'companion_set_setting',
]);

export const READ_TOOLS: ReadonlySet<string> = new Set([
  'list_apps',
  'read_skill',
  'find_places',
  'focus_window',
  'read_focused',
  'look',
  'see',
  'browser_tabs',
  'browser_read',
  'companion_state',
  'companion_island',
  'companion_settings',
  'companion_thread',
  'companion_last_message_matches',
  'companion_log',
  'companion_turns',
  'companion_screen',
  'companion_controls',
  'companion_capture',
]);

// Reads that block on purpose: companion_wait_turn parks on a continuation inside Companion (up to
// 100 s) until the turn ends or a Touch ID prompt opens. It must not get the 30 s read timeout,
// and it is not an action, so it carries no "may still have happened" warning.
export const LONG_TOOLS: ReadonlySet<string> = new Set(['companion_wait_turn']);

// A tool in no list is treated as an action: waiting longer and warning that it may have
// happened is the safe mistake.
export function isWriteTool(name: string): boolean {
  return !READ_TOOLS.has(name) && !LONG_TOOLS.has(name);
}
