// workspace/tools/fs-walk.ts — grep/find 兜底工具共用的目录遍历器(PC 自建)
// pi 的 grep/find 默认 shell 出 ripgrep/fd 二进制(ensureTool 会联网下载);PC 的兜底
// 场景恰恰是"这台 Windows 连 bash 都没有",不再引入外部二进制,用纯 TS 遍历 + Bun.Glob。
// 语义:
// - 恒跳过 .git 与 node_modules(与 pi find 自定义 ops 路径的 ignore 清单一致),不可被
//   .gitignore 取回(安全边界,同 pi);
// - 额外跳过一份"公认构建产物目录"(SKIPPED_ARTIFACT_DIRS,见下):pi 自身有 fd/.gitignore
//   兜底故不内置,而本工具恰为无 fd 的 Windows 兜底,无 .gitignore 覆盖的项目会白遍历万级
//   产物(实测 src-tauri/target 14591 条目)。与 .gitignore 同层判定,可被 !dir/ 取回;
//   回退到纯 pi 语义只需清空该数组,遍历逻辑不变;
// - 支持 .gitignore 常用子集:空行/注释、取反 !、目录尾 /、含 / 的锚定模式、*/**/? 通配;
//   逐目录叠加,同 git 语义"后规则覆盖先规则";
// - 不跟随符号链接(边界安全:区内软链指向区外时遍历不越界);
// - maxVisited 安全罩防超大目录树失控,命中时结果如实标注。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const ALWAYS_SKIPPED_DIRS = new Set([".git", "node_modules"]);

/**
 * 公认构建产物/缓存目录名,遍历整树跳过(可被 .gitignore 的 !name/ 取回)。
 * 只收"几乎不可能作为源码目录"者,降低误伤;源码恰叫这些名的项目可用 !name/ 显式要回。
 * 留空即回退到 pi 原生语义(只跳 .git/node_modules + .gitignore)。
 */
const SKIPPED_ARTIFACT_DIRS: readonly string[] = [
  "target", // Rust / Maven
  "build",
  "dist",
  "out",
  "coverage", // 测试覆盖率报告
  "__pycache__", // Python 字节码缓存
  ".next", // Next.js
  ".nuxt", // Nuxt
  ".svelte-kit", // SvelteKit
  ".turbo", // Turborepo 缓存
  ".cache",
  ".parcel-cache",
  ".react-router", // React Router 7 构建产物
];
const SKIPPED_ARTIFACT_SET: ReadonlySet<string> = new Set(SKIPPED_ARTIFACT_DIRS);

const DEFAULT_MAX_VISITED = 100_000;

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  /** true=按 basename 任意深度匹配(模式不含 /);false=按相对 .gitignore 所在目录的路径匹配 */
  basenameOnly: boolean;
  glob: Glob;
}

/** 编译一份 .gitignore 文本为规则数组;prefix 是该 .gitignore 所在目录相对遍历根的 posix 前缀。 */
function compileGitignore(content: string, prefix: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    try {
      if (anchored) {
        const pattern = prefix ? `${prefix}/${line}` : line;
        rules.push({ negated, dirOnly, basenameOnly: false, glob: new Glob(pattern) });
      } else {
        rules.push({ negated, dirOnly, basenameOnly: true, glob: new Glob(line) });
      }
    } catch {
      // 非法模式按 git 行为静默跳过
    }
  }
  return rules;
}

/** 后规则覆盖先规则:遍历全部规则取最后一次命中的取反位。 */
function isIgnored(rules: IgnoreRule[], relativePath: string, baseName: string, isDirectory: boolean): boolean {
  // 产物目录跳过作为"第 0 条规则",可被 .gitignore 的 !name/ 取反覆盖(后规则覆盖先规则)。
  // SKIPPED_ARTIFACT_DIRS 留空时此分支恒 false,自然回退到纯 .gitignore 语义。
  let ignored = isDirectory && SKIPPED_ARTIFACT_SET.has(baseName);
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue;
    const hit = rule.basenameOnly ? rule.glob.match(baseName) : rule.glob.match(relativePath);
    if (hit) ignored = !rule.negated;
  }
  return ignored;
}

export interface WalkEntry {
  absolutePath: string;
  /** 相对遍历根的 posix 路径 */
  relativePath: string;
  isDirectory: boolean;
}

export interface WalkOptions {
  signal?: AbortSignal;
  /** 访问条目安全罩,默认 100_000 */
  maxVisited?: number;
  /** 是否回调目录条目(find 需要,grep 不需要) */
  includeDirectories?: boolean;
  /** 返回 false 提前终止遍历(如命中结果上限) */
  onEntry: (entry: WalkEntry) => boolean | void;
}

export interface WalkResult {
  stoppedEarly: boolean;
  visitCapReached: boolean;
}

/** 同步深度优先遍历(工作区本地盘,同步足够;签名/上限双闸)。条目按字典序回调,输出稳定。 */
export function walkDirectory(root: string, options: WalkOptions): WalkResult {
  const maxVisited = options.maxVisited ?? DEFAULT_MAX_VISITED;
  let visited = 0;
  let stoppedEarly = false;
  let visitCapReached = false;

  const visit = (dir: string, prefix: string, inheritedRules: IgnoreRule[]): boolean => {
    if (options.signal?.aborted) throw new Error("Operation aborted");

    let rules = inheritedRules;
    try {
      const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
      rules = [...inheritedRules, ...compileGitignore(gitignore, prefix)];
    } catch {
      // 无 .gitignore 是常态
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true; // 不可读目录跳过,不让单点故障终止全局遍历
    }
    entries.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

    for (const entry of entries) {
      if (options.signal?.aborted) throw new Error("Operation aborted");
      if (entry.isSymbolicLink()) continue;
      const isDirectory = entry.isDirectory();
      if (!isDirectory && !entry.isFile()) continue;
      if (isDirectory && ALWAYS_SKIPPED_DIRS.has(entry.name)) continue;

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isIgnored(rules, relativePath, entry.name, isDirectory)) continue;

      if (++visited > maxVisited) {
        visitCapReached = true;
        return false;
      }

      if (!isDirectory || options.includeDirectories) {
        const keepGoing = options.onEntry({ absolutePath: join(dir, entry.name), relativePath, isDirectory });
        if (keepGoing === false) {
          stoppedEarly = true;
          return false;
        }
      }
      if (isDirectory && !visit(join(dir, entry.name), relativePath, rules)) return false;
    }
    return true;
  };

  visit(root, "", []);
  return { stoppedEarly, visitCapReached };
}
