import { describe, expect, test } from "bun:test";
import {
  defaultKeybindings,
  eventToTokens,
  findConflict,
  formatBinding,
  formatToken,
  isValidBinding,
  tokensEqual,
  wheelZoomDirection,
} from "~/lib/hotkeys";
import { isComposingKeyEvent, shouldSendOnEnter } from "~/lib/input-keyboard";

function keyEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter", code: "Enter", keyCode: 13, isComposing: false,
    metaKey: false, ctrlKey: false, altKey: false, shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

const wheel = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, deltaX: 0, deltaY: -10 };

describe("platform shortcuts and recording", () => {
  test("Mac defaults use Cmd and preserve Option arrow text navigation", () => {
    const defaults = defaultKeybindings("macos");
    expect(defaults.newConversation.keys).toEqual(["Meta", "N"]);
    expect(defaults.prevConversation.keys).toEqual(["Alt", "Meta", "Up"]);
    expect(defaults.nextConversation.keys).toEqual(["Alt", "Meta", "Down"]);
    expect(defaults.openSettings.keys).toEqual(["Meta", ","]);
    for (const key of ["A", "C", "V", "X", "Z"]) {
      expect(findConflict("zoomInOut", ["Meta", key], defaults)).toBeNull();
    }
    expect(findConflict("zoomInOut", ["Alt", "Up"], defaults)).toBeNull();
  });

  test("Windows defaults retain their existing Ctrl and Alt tokens", () => {
    const defaults = defaultKeybindings("windows");
    expect(defaults.newConversation.keys).toEqual(["Ctrl", "N"]);
    expect(defaults.searchConversations.keys).toEqual(["Ctrl", "Shift", "F"]);
    expect(defaults.prevConversation.keys).toEqual(["Alt", "Up"]);
    expect(defaults.openSettings.keys).toEqual(["Ctrl", ","]);
  });

  test("display labels distinguish Cmd/Option from Ctrl and Win/Alt", () => {
    expect(formatBinding(["Meta", ","], "macos")).toBe("Cmd+,");
    expect(formatToken("Alt", "macos")).toBe("Option");
    expect(formatToken("Ctrl", "macos")).toBe("Ctrl");
    expect(formatToken("Meta", "windows")).toBe("Win");
    expect(formatToken("Alt", "windows")).toBe("Alt");
  });

  test("record physical Cmd/Option/Shift chords even when the produced character changes", () => {
    expect(eventToTokens(keyEvent({ code: "KeyE", key: "é", altKey: true, metaKey: true })))
      .toEqual(["Alt", "Meta", "E"]);
    expect(eventToTokens(keyEvent({ code: "Digit5", key: "%", shiftKey: true, metaKey: true })))
      .toEqual(["Shift", "Meta", "5"]);
    expect(eventToTokens(keyEvent({ code: "MetaLeft", key: "Meta", metaKey: true }))).toEqual([]);
    expect(isValidBinding(["Alt", "Meta", "E"])).toBe(true);
    expect(isValidBinding(["Meta"])).toBe(false);
  });

  test("conflicts are order independent and disabled bindings do not reserve keys", () => {
    const defaults = defaultKeybindings("macos");
    expect(tokensEqual(["Meta", "Shift", "F"], defaults.searchConversations.keys!)).toBe(true);
    expect(findConflict("newConversation", ["Meta", "Shift", "F"], defaults)).toBe("searchConversations");
    defaults.searchConversations.enabled = false;
    expect(findConflict("newConversation", ["Meta", "Shift", "F"], defaults)).toBeNull();
  });
});

describe("IME and chat submission", () => {
  test.each([
    { isComposing: true },
    { key: "Process" },
    { isComposing: false, keyCode: 229 },
  ])("composition signals prevent ordinary and Cmd+Enter submission: %j", (composition) => {
    const event = keyEvent({ metaKey: true, ...composition });
    expect(isComposingKeyEvent(event)).toBe(true);
    expect(shouldSendOnEnter(event, true, "macos")).toBe(false);
    expect(shouldSendOnEnter(event, false, "macos")).toBe(false);
  });

  test("Escape during candidate selection belongs to IME", () => {
    expect(isComposingKeyEvent(keyEvent({ key: "Escape", keyCode: 229 }))).toBe(true);
  });

  test.each([true, false])("Enter/Shift+Enter preserve sendOnEnter=%s", (sendOnEnter) => {
    expect(shouldSendOnEnter(keyEvent(), sendOnEnter, "macos")).toBe(sendOnEnter);
    expect(shouldSendOnEnter(keyEvent({ shiftKey: true }), sendOnEnter, "macos")).toBe(!sendOnEnter);
    expect(shouldSendOnEnter(keyEvent({ metaKey: true }), sendOnEnter, "macos")).toBe(true);
    expect(shouldSendOnEnter(keyEvent({ key: "A", code: "KeyA" }), sendOnEnter, "macos")).toBe(false);
  });

  test("Windows Enter behavior is unaffected by the Mac Cmd+Enter addition", () => {
    expect(shouldSendOnEnter(keyEvent({ ctrlKey: true }), true, "windows")).toBe(true);
    expect(shouldSendOnEnter(keyEvent({ ctrlKey: true }), false, "windows")).toBe(false);
  });
});

describe("wheel zoom and trackpad gestures", () => {
  test("macOS uses Cmd+vertical wheel in either direction", () => {
    expect(wheelZoomDirection({ ...wheel, metaKey: true }, "macos")).toBe(1);
    expect(wheelZoomDirection({ ...wheel, metaKey: true, deltaY: 10 }, "macos")).toBe(-1);
  });

  test("pinch, ordinary scrolling, horizontal movement and zero delta do not change font size", () => {
    expect(wheelZoomDirection(wheel, "macos")).toBeNull();
    expect(wheelZoomDirection({ ...wheel, ctrlKey: true }, "macos")).toBeNull();
    expect(wheelZoomDirection({ ...wheel, metaKey: true, ctrlKey: true }, "macos")).toBeNull();
    expect(wheelZoomDirection({ ...wheel, metaKey: true, deltaX: 20 }, "macos")).toBeNull();
    expect(wheelZoomDirection({ ...wheel, metaKey: true, deltaY: 0 }, "macos")).toBeNull();
    expect(wheelZoomDirection({ ...wheel, metaKey: true, shiftKey: true }, "macos")).toBeNull();
  });

  test("Windows retains Ctrl+wheel", () => {
    expect(wheelZoomDirection({ ...wheel, ctrlKey: true }, "windows")).toBe(1);
    expect(wheelZoomDirection({ ...wheel, metaKey: true }, "windows")).toBeNull();
  });
});
