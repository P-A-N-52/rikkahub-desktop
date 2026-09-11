/** IME owns its key events, including WebKit's Enter event during composition commit. */
export function isComposingKeyEvent(
  event: Pick<KeyboardEvent, "isComposing" | "key" | "keyCode">,
): boolean {
  return event.isComposing || event.key === "Process" || event.keyCode === 229;
}

/** Cmd+Enter sends on macOS; ordinary Enter/Shift+Enter retain the user's setting. */
export function shouldSendOnEnter(
  event: Pick<KeyboardEvent, "key" | "keyCode" | "isComposing" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  sendOnEnter: boolean,
  platform: string,
): boolean {
  if (event.key !== "Enter" || isComposingKeyEvent(event)) return false;
  if (platform === "macos" && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) return true;
  return sendOnEnter ? !event.shiftKey : event.shiftKey;
}
