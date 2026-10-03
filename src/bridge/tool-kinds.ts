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
  'browser_type',
  'browser_navigate',
  'browser_open',
  'browser_take',
  'browser_release',
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
]);

// A tool in neither list is treated as an action: waiting longer and warning that it may have
// happened is the safe mistake.
export function isWriteTool(name: string): boolean {
  return !READ_TOOLS.has(name);
}
