import { lstatSync, realpathSync, statSync, type BigIntStats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { reservedNameSafeFsPath } from "../foundation/windows-names";

export interface PathIdentity {
  /** 可操作路径；不存在的尾段拼接在真实的现存祖先之后。 */
  path: string;
  existingPath: string;
  stats: BigIntStats;
  exists: boolean;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** 仅真正缺失的尾段允许向上解析；权限错误、循环或悬空链接必须报错。 */
export function resolvePathIdentity(input: string): PathIdentity {
  let current = resolve(input);
  const tail: string[] = [];
  for (;;) {
    try {
      const existingPath = realpathSync(reservedNameSafeFsPath(current));
      const stats = statSync(reservedNameSafeFsPath(existingPath), { bigint: true });
      return { path: join(existingPath, ...tail.slice().reverse()), existingPath, stats, exists: tail.length === 0 };
    } catch (error) {
      if (!isMissing(error)) throw error;
      // realpath 的 ENOENT 也可能来自悬空链接，不能把链接当成尚未创建的普通目录。
      let missing = false;
      try {
        lstatSync(reservedNameSafeFsPath(current));
      } catch (entryError) {
        if (!isMissing(entryError)) throw entryError;
        missing = true;
      }
      const parent = dirname(current);
      if (!missing || parent === current) throw error;
      tail.push(basename(current));
      current = parent;
    }
  }
}

function sameEntry(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** 现存条目按文件系统身份判等，不猜测所在卷的大小写或 Unicode 规则。 */
export function samePathIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.exists && right.exists && sameEntry(left.stats, right.stats);
}

/** root 必须为现存目录；目标可以是尚未创建的文件或目录。 */
export function isPathWithin(target: PathIdentity, root: PathIdentity): boolean {
  if (!root.exists || !root.stats.isDirectory()) return false;
  let current = target.existingPath;
  let stats = target.stats;
  for (;;) {
    if (sameEntry(stats, root.stats)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
    stats = statSync(reservedNameSafeFsPath(current), { bigint: true });
  }
}
