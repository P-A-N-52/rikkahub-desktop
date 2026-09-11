import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPathWithin, resolvePathIdentity, samePathIdentity } from "./path-identity";

const host = mkdtempSync(join(process.env.RIKKAHUB_PATH_TEST_DIR ?? tmpdir(), "rkh-path-identity-"));
const root = join(host, "工作区 with spaces");
const outside = join(host, "outside");
mkdirSync(root);
mkdirSync(outside);
writeFileSync(join(root, "file.txt"), "inside");
writeFileSync(join(outside, "file.txt"), "outside");

afterAll(() => rmSync(host, { recursive: true, force: true }));

describe("filesystem path identity", () => {
  test("现存路径、尾分隔符与同目录身份一致", () => {
    const identity = resolvePathIdentity(root);
    expect(identity.exists).toBe(true);
    expect(identity.path).toBe(realpathSync(root));
    expect(identity.stats.isDirectory()).toBe(true);
    expect(samePathIdentity(identity, resolvePathIdentity(`${root}/`))).toBe(true);
    expect(isPathWithin(identity, identity)).toBe(true);
    expect(isPathWithin(resolvePathIdentity(join(root, "file.txt")), identity)).toBe(true);
  });

  test("缺失尾段保留原名并归属于真实的现存祖先", () => {
    const identity = resolvePathIdentity(join(root, "new directory", "新文件.txt"));
    expect(identity.exists).toBe(false);
    expect(identity.existingPath).toBe(realpathSync(root));
    expect(identity.path).toBe(join(realpathSync(root), "new directory", "新文件.txt"));
    expect(isPathWithin(identity, resolvePathIdentity(root))).toBe(true);
  });

  test("同一祖先下两个缺失路径不等同，缺失路径不能成为边界根", () => {
    const first = resolvePathIdentity(join(root, "missing-a"));
    const second = resolvePathIdentity(join(root, "missing-b"));
    expect(samePathIdentity(first, second)).toBe(false);
    expect(samePathIdentity(first, first)).toBe(false);
    expect(isPathWithin(resolvePathIdentity(join(root, "missing-a", "child")), first)).toBe(false);
    expect(isPathWithin(resolvePathIdentity(root), first)).toBe(false);
  });

  test("文件不能成为边界根，现存文件后的尾段不能当作新目录", () => {
    const file = resolvePathIdentity(join(root, "file.txt"));
    expect(isPathWithin(file, file)).toBe(false);
    expect(() => resolvePathIdentity(join(root, "file.txt", "child"))).toThrow(/ENOTDIR/);
  });

  test("区外现存路径、缺失尾段与同级前缀目录均不属于工作区", () => {
    const identity = resolvePathIdentity(root);
    const sibling = `${root}2`;
    mkdirSync(sibling);
    expect(isPathWithin(resolvePathIdentity(outside), identity)).toBe(false);
    expect(isPathWithin(resolvePathIdentity(join(outside, "missing", "child")), identity)).toBe(false);
    expect(isPathWithin(resolvePathIdentity(sibling), identity)).toBe(false);
    expect(isPathWithin(resolvePathIdentity(join(sibling, "child")), identity)).toBe(false);
  });

  test("大小写判断遵循夹具所在的真实文件系统", () => {
    const upper = join(host, "CaseDirectory");
    const lower = join(host, "casedirectory");
    mkdirSync(upper);
    mkdirSync(lower, { recursive: true });
    const upperStat = statSync(upper, { bigint: true });
    const lowerStat = statSync(lower, { bigint: true });
    const caseAliases = upperStat.dev === lowerStat.dev && upperStat.ino === lowerStat.ino;
    const upperIdentity = resolvePathIdentity(upper);
    const lowerIdentity = resolvePathIdentity(lower);
    expect(samePathIdentity(upperIdentity, lowerIdentity)).toBe(caseAliases);
    expect(isPathWithin(lowerIdentity, upperIdentity)).toBe(caseAliases);
    expect(isPathWithin(resolvePathIdentity(join(lower, "new-child")), upperIdentity)).toBe(caseAliases);
  });

  test("NUL 路径不能被当作缺失尾段", () => {
    expect(() => resolvePathIdentity(join(root, "invalid\0name"))).toThrow();
  });
});

describe.skipIf(process.platform === "win32")("真实符号链接", () => {
  test("根别名与区内链接按目标身份比较，允许区内新建尾段", () => {
    const alias = join(host, "root-alias");
    const local = join(root, "local-link");
    symlinkSync(root, alias);
    symlinkSync(root, local);
    const identity = resolvePathIdentity(root);
    expect(samePathIdentity(resolvePathIdentity(alias), identity)).toBe(true);
    expect(samePathIdentity(resolvePathIdentity(local), identity)).toBe(true);
    expect(isPathWithin(resolvePathIdentity(join(alias, "new", "file")), identity)).toBe(true);
    expect(isPathWithin(resolvePathIdentity(join(root, "file.txt")), resolvePathIdentity(alias))).toBe(true);
  });

  test("区外祖先链接对现存文件和新建尾段均不能越界", () => {
    const link = join(root, "outside-link");
    symlinkSync(outside, link);
    const identity = resolvePathIdentity(root);
    expect(isPathWithin(resolvePathIdentity(link), identity)).toBe(false);
    expect(isPathWithin(resolvePathIdentity(join(link, "file.txt")), identity)).toBe(false);
    expect(isPathWithin(resolvePathIdentity(join(link, "new", "file.txt")), identity)).toBe(false);
  });

  test("悬空链接及其后代报错，不能成为缺失尾段", () => {
    const link = join(root, "dangling-link");
    symlinkSync(join(outside, "does-not-exist"), link);
    expect(() => resolvePathIdentity(link)).toThrow(/ENOENT/);
    expect(() => resolvePathIdentity(join(link, "child"))).toThrow(/ENOENT/);
  });

  test("循环链接及其后代报错，不能退回词法路径", () => {
    const first = join(root, "loop-a");
    const second = join(root, "loop-b");
    symlinkSync(second, first);
    symlinkSync(first, second);
    expect(() => resolvePathIdentity(first)).toThrow(/ELOOP/);
    expect(() => resolvePathIdentity(join(first, "child"))).toThrow(/ELOOP/);
  });

  test("现存文件链接之后不能拼接新建尾段", () => {
    const link = join(root, "file-link");
    symlinkSync(join(root, "file.txt"), link);
    expect(() => resolvePathIdentity(join(link, "child"))).toThrow(/ENOTDIR/);
  });
});

test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("权限拒绝不会退回可写的词法路径", () => {
  const blocked = join(host, "no-access");
  mkdirSync(blocked);
  writeFileSync(join(blocked, "existing.txt"), "private fixture");
  chmodSync(blocked, 0o000);
  try {
    expect(() => resolvePathIdentity(join(blocked, "existing.txt"))).toThrow(/EACCES|EPERM/);
    expect(() => resolvePathIdentity(join(blocked, "missing", "child"))).toThrow(/EACCES|EPERM/);
  } finally {
    chmodSync(blocked, 0o700);
  }
});
