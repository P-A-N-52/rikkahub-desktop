// foundation/windows-names.test.ts — Windows 保留设备名单源工具组的单测。
// 字面保留名文件的创建走 \\?\ NT 路径写入(与野外制造者同一通道),只在 win32 上有意义,
// 相关用例用 test.if(onWindows) 守卫;纯判定函数跨平台恒测。
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isWindowsReservedName, reservedNameSafeFsPath, sweepWindowsReservedNames, windowsSafeFsPath } from "./windows-names";

const onWindows = process.platform === "win32";
const labDir = mkdtempSync(join(tmpdir(), "rkh-winnames-"));

afterAll(() => {
  // 残留的保留名文件必须经 NT 路径清理,普通 rmSync 递归在 win32 上删不掉它们
  sweepWindowsReservedNames(labDir);
  rmSync(labDir, { recursive: true, force: true });
});

describe("isWindowsReservedName:裸名/扩展名/大小写矩阵", () => {
  test("命中:经典设备名的裸名与带扩展名形式,大小写不敏感", () => {
    for (const name of ["nul", "NUL", "Nul", "con", "PRN", "aux", "com1", "COM9", "lpt1", "LPT9", "nul.txt", "CON.log", "com3.tar.gz"]) {
      expect(isWindowsReservedName(name)).toBe(true);
    }
  });
  test("不命中:普通名、前缀相似名、越界编号", () => {
    for (const name of ["null", "nulx", "console", "com0", "com10", "lpt0", "auxiliary", "prnt", ".nul", "a.nul", "readme.md", ""]) {
      expect(isWindowsReservedName(name)).toBe(false);
    }
  });
});

describe("windowsSafeFsPath:NT 前缀形式", () => {
  test.if(onWindows)("盘符路径加 \\\\?\\ 前缀;已带前缀原样;UNC 转 \\\\?\\UNC", () => {
    expect(windowsSafeFsPath(String.raw`D:\ws\files\nul`)).toBe(String.raw`\\?\D:\ws\files\nul`);
    expect(windowsSafeFsPath(String.raw`\\?\D:\already`)).toBe(String.raw`\\?\D:\already`);
    expect(windowsSafeFsPath(String.raw`\\server\share\nul`)).toBe(String.raw`\\?\UNC\server\share\nul`);
  });
  test.if(!onWindows)("非 win32 平台原样返回", () => {
    expect(windowsSafeFsPath("/tmp/nul")).toBe("/tmp/nul");
  });
  test("reservedNameSafeFsPath:保留名走安全形式,普通名零改变", () => {
    const normal = join(labDir, "readme.md");
    expect(reservedNameSafeFsPath(normal)).toBe(normal);
    const reserved = join(labDir, "nul");
    if (onWindows) {
      expect(reservedNameSafeFsPath(reserved).startsWith("\\\\?\\")).toBe(true);
    } else {
      expect(reservedNameSafeFsPath(reserved)).toBe(reserved);
    }
  });
});

describe("sweepWindowsReservedNames:顶层保留裸名清扫", () => {
  test.if(onWindows)("字面 nul/com3 文件被清;普通文件、带扩展名保留名、子目录内残留不动", async () => {
    const dir = join(labDir, "sweep-case");
    const sub = join(dir, "sub");
    mkdirSync(sub, { recursive: true });
    // 造字面保留名文件用 Bun.write + NT 路径:node:fs 对裸 nul 有设备特判(连 NT 前缀
    // 也拦,实证于 2026-09),Bun.write 不拦——与野外制造者(Bun 相对路径写)同一落盘通道。
    await Bun.write(windowsSafeFsPath(join(dir, "nul")), "stray");
    await Bun.write(windowsSafeFsPath(join(dir, "COM3")), "stray");
    await Bun.write(windowsSafeFsPath(join(dir, "nul.txt")), "not-bare");
    writeFileSync(join(dir, "keep.md"), "keep");
    await Bun.write(windowsSafeFsPath(join(sub, "nul")), "deep-stray");

    const removed = sweepWindowsReservedNames(dir).sort();
    expect(removed).toEqual(["COM3", "nul"]);

    const rest = readdirSync(dir).sort();
    expect(rest).toEqual(["keep.md", "nul.txt", "sub"]);
    // 子目录内的残留不在顶层清扫范围(文件面板可手工处置)
    expect(existsSync(windowsSafeFsPath(join(sub, "nul")))).toBe(true);
    // 清理深层残留,避免 afterAll 的递归删除在 win32 上被卡
    sweepWindowsReservedNames(sub);
  });
  test.if(onWindows)("目标目录不存在时静默返回空", () => {
    expect(sweepWindowsReservedNames(join(labDir, "no-such-dir"))).toEqual([]);
  });
  test.if(!onWindows)("非 win32 平台恒为空操作", () => {
    const dir = join(labDir, "posix-case");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "nul"), "legit-posix-file");
    expect(sweepWindowsReservedNames(dir)).toEqual([]);
    expect(existsSync(join(dir, "nul"))).toBe(true);
  });
});
