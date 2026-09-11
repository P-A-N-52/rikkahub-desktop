import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheFontFamilies, parseFontFamilies, querySystemFontFamilies, systemFontCommand } from "./system-fonts";

describe("system font catalog", () => {
  test("native mode is explicit and never replaced by a guessed helper", () => {
    expect(systemFontCommand("darwin", "/Applications/Test App.app/Contents/MacOS/test")?.args).toEqual(["--list-system-fonts"]);
    expect(systemFontCommand("darwin")?.executable).toBe("/usr/sbin/system_profiler");
    expect(() => systemFontCommand("darwin", "relative/helper")).toThrow("absolute");
    expect(() => systemFontCommand("darwin", "")).toThrow("absolute");
    expect(systemFontCommand("other")).toBeNull();
  });
  test("native names preserve Unicode, deduplicate and omit private/control names", () => {
    expect(parseFontFamilies('["Arial"," 苹方-简 ","Arial",".Private","bad\\nname"]', "families"))
      .toEqual(["Arial", "苹方-简"].sort((a,b) => a.localeCompare(b)));
    expect(() => parseFontFamilies('["Arial", null]', "families")).toThrow("invalid");
  });
  test("profiler includes only valid and enabled typeface families", () => {
    const validFace = { enabled: "yes", valid: "yes", family: "Visible" };
    const validFile = { enabled: "yes", valid: "yes", typefaces: [validFace] };
    expect(parseFontFamilies(JSON.stringify({ SPFontsDataType: [validFile,
      { ...validFile, enabled: "no" }, { ...validFile, valid: "no" },
      { ...validFile, typefaces: [{ ...validFace, enabled: "no", family: "Disabled" }] },
    ] }), "profiler")).toEqual(["Visible"]);
    expect(() => parseFontFamilies("{}", "profiler")).toThrow("SPFontsDataType");
  });
  test("retains existing Windows and fontconfig name formats", () => {
    expect(parseFontFamilies("Arial\r\n微软雅黑\r\nArial\r\n", "lines")).toHaveLength(2);
    expect(parseFontFamilies("Alpha,Alt Alpha\nBeta\n/path: invalid\n", "fontconfig")).toEqual(["Alpha", "Alt Alpha", "Beta"]);
  });
  test("concurrent readers share the same successful query", async () => {
    let calls = 0;
    const get = cacheFontFamilies(async () => { calls++; await Bun.sleep(5); return ["Arial"]; });
    expect(await Promise.all([get(), get(), get()])).toEqual([["Arial"], ["Arial"], ["Arial"]]);
    await get(); expect(calls).toBe(1);
  });
  test("failure may be retried but does not cache invented fonts", async () => {
    let calls = 0;
    const get = cacheFontFamilies(async () => { if (++calls === 1) throw new Error("helper failed"); return ["Arial"]; });
    await expect(get()).rejects.toThrow("helper failed");
    expect(await get()).toEqual(["Arial"]); expect(calls).toBe(2);
  });
  test.skipIf(process.platform === "win32")("executes an absolute helper without shell interpolation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "font-helper-"));
    const helper = join(dir, "helper with spaces");
    try {
      writeFileSync(helper, "#!/bin/sh\ntest \"$1\" = \"--list-system-fonts\" || exit 7\nprintf '[\"Arial\",\"苹方-简\"]'\n");
      chmodSync(helper, 0o700);
      expect(await querySystemFontFamilies("darwin", helper)).toHaveLength(2);
      writeFileSync(helper, "#!/bin/sh\nexit 3\n");
      await expect(querySystemFontFamilies("darwin", helper)).rejects.toThrow("exited with 3");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
