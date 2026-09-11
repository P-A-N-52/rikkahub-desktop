import { describe, expect, test } from "bun:test";
import { defaultSettings } from "../app-config/defaults";
import type { JsonValue } from "../foundation/types";
import { defaultKeybindings, KEYBINDING_ORDER } from "../shared/keybindings";
import { normalizeState } from "./state-load";

const platform = process.platform === "darwin" ? "macos" : process.platform;

function normalizeBindings(keybindings: Record<string, JsonValue>) {
  return normalizeState({ settings: { keybindings } as never }).settings.keybindings;
}

describe("platform shortcut defaults and saved settings", () => {
  test("new installs and explicit reset source use the shared platform defaults", () => {
    const expected = defaultKeybindings(platform);
    expect(defaultSettings().keybindings).toEqual(expected);
    expect(normalizeState({}).settings.keybindings).toEqual(expected);
    expect(Object.keys(expected)).toEqual([...KEYBINDING_ORDER]);
  });

  test("legacy Ctrl bindings, disabled actions and empty keys stay unchanged", () => {
    const saved = {
      newConversation: { keys: ["Ctrl", "N"], enabled: false },
      prevConversation: { keys: ["Alt", "Up"], enabled: true },
      openSettings: { keys: [], enabled: false },
      zoomInOut: { enabled: false },
    };
    const normalized = normalizeBindings(saved);
    for (const [action, entry] of Object.entries(saved)) expect(normalized[action]).toEqual(entry);
    expect(normalizeBindings(normalized)).toEqual(normalized);
  });

  test("missing actions and fields are filled without replacing saved fields", () => {
    const defaults = defaultKeybindings(platform);
    const normalized = normalizeBindings({
      newConversation: { keys: ["Ctrl", "Shift", "P"] },
      nextConversation: { enabled: false },
      unknownAction: { keys: ["F9"], enabled: true },
    });
    expect(normalized.newConversation).toEqual({ keys: ["Ctrl", "Shift", "P"], enabled: true });
    expect(normalized.nextConversation).toEqual({ ...defaults.nextConversation, enabled: false });
    expect(normalized.searchConversations).toEqual(defaults.searchConversations);
    expect(Object.hasOwn(normalized, "unknownAction")).toBe(false);
  });

  test("reset defaults are independent objects and do not rewrite the saved configuration", () => {
    const saved = { openSettings: { keys: ["Ctrl", ","], enabled: false } };
    normalizeBindings(saved);
    const reset = defaultSettings().keybindings;
    const fresh = defaultSettings().keybindings;
    (reset.openSettings as { keys: string[] }).keys.push("X");
    expect(fresh).toEqual(defaultKeybindings(platform));
    expect(saved).toEqual({ openSettings: { keys: ["Ctrl", ","], enabled: false } });
  });
});
