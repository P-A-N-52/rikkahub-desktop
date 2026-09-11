/** Shared desktop shortcut contract. Keep this module free of server and browser runtimes. */
export const KEYBINDING_ORDER = [
  "newConversation",
  "prevConversation",
  "nextConversation",
  "renameConversation",
  "searchConversations",
  "openSettings",
  "openImageGeneration",
  "zoomInOut",
] as const;

export type KeybindingAction = typeof KEYBINDING_ORDER[number];

/** zoomInOut has no recordable keys; its wheel gesture only has an enabled switch. */
export type KeybindingEntry = {
  keys?: string[];
  enabled: boolean;
};

/** Fresh objects for new installs, missing entries and explicit resets; never migrate saved keys. */
export function defaultKeybindings(platform: string): Record<KeybindingAction, KeybindingEntry> {
  const primary = platform === "macos" ? "Meta" : "Ctrl";
  // Option+arrows remain available for native text navigation on macOS.
  const conversationModifiers = platform === "macos" ? ["Alt", "Meta"] : ["Alt"];
  return {
    newConversation: { keys: [primary, "N"], enabled: true },
    prevConversation: { keys: [...conversationModifiers, "Up"], enabled: true },
    nextConversation: { keys: [...conversationModifiers, "Down"], enabled: true },
    renameConversation: { keys: ["F2"], enabled: true },
    searchConversations: { keys: platform === "macos" ? ["Shift", "Meta", "F"] : ["Ctrl", "Shift", "F"], enabled: true },
    openSettings: { keys: [primary, ","], enabled: true },
    openImageGeneration: { keys: [primary, "I"], enabled: true },
    zoomInOut: { enabled: true },
  };
}
