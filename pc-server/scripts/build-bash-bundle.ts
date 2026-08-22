// scripts/build-bash-bundle.ts — 内嵌 bash 运行时的打包器(仅 Windows 用)。
// 从本机 Git for Windows(MSYS2)安装里抽取"bash + coreutils 最小子集 + 完整 dll 闭包",
// 打成 pc-server/assets/bash-bundle.tar.gz(被 embedded-bash.ts 以 with { type: "file" } 嵌入),
// 并生成进 git 的 bash-bundle.version.json(版本戳/清单,落地覆盖判定用)。
//
// 用法:
//   bun run scripts/build-bash-bundle.ts [--src "D:\\SoftWare\\Git"] [--force]
//   --src   Git for Windows 安装根(含 usr/bin)。缺省自动从常见位置/PATH 上的 git.exe 推导。
//   --force 已存在且版本戳相同也强制重打。
//
// 设计要点(为什么是脚本自动求闭包,而非手列 dll):
//   手挑极易漏——POC 阶段就漏了 msys-gcc_s-seh-1.dll(gawk/awk 的隐式依赖),导致 awk 报
//   "cannot open shared object file"。故这里对每个工具跑 ldd,递归收集全部 msys-*.dll。
//   MSYS2 按"exe 与 dll 同目录平铺"解析,落地目录必须保持 usr/bin/ 平铺结构。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// ── 工具清单(agent 执行命令的高频子集;不含 git/ssh/vim/perl/gpg 等无关大件)──
// sh.exe 是 bash 的副本(bash 以 sh 名调用时进 POSIX 模式),带上以满足 `sh -c` 习惯写法。
const TOOLS = [
  "bash.exe", "sh.exe",
  // 文件与文本
  "ls.exe", "cat.exe", "cp.exe", "mv.exe", "rm.exe", "rmdir.exe", "mkdir.exe", "pwd.exe",
  "echo.exe", "printf.exe", "grep.exe", "sed.exe", "gawk.exe", "awk.exe", "find.exe", "xargs.exe",
  "head.exe", "tail.exe", "wc.exe", "sort.exe", "uniq.exe", "cut.exe", "tr.exe", "tee.exe",
  "diff.exe", "comm.exe", "paste.exe", "join.exe", "du.exe", "df.exe",
  // 路径与系统
  "test.exe", "dirname.exe", "basename.exe", "realpath.exe", "readlink.exe", "cygpath.exe",
  "touch.exe", "chmod.exe", "uname.exe", "which.exe", "sleep.exe", "date.exe", "env.exe",
  "true.exe", "false.exe", "mktemp.exe", "install.exe", "unlink.exe",
  "id.exe", "whoami.exe", "hostname.exe", "nproc.exe",
  // 压缩(agent 常打包/解包)
  "gzip.exe", "gunzip", "zcat", "tar.exe",
];

const ROOT = resolve(import.meta.dir, "..");
const ASSETS_DIR = join(ROOT, "assets");
const STAGING_DIR = join(ASSETS_DIR, "bash");           // gitignored 工作目录
const OUT_BUNDLE = join(ASSETS_DIR, "bash-bundle.tar.gz"); // gitignored 产物
const OUT_VERSION = join(ASSETS_DIR, "bash-bundle.version.json"); // 进 git 的版本戳

interface Args { src: string | null; force: boolean }
function parseArgs(): Args {
  const args = process.argv.slice(2);
  let src: string | null = null;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--src") src = args[++i] ?? null;
    else if (args[i] === "--force") force = true;
  }
  return { src, force };
}

/** 从 PATH 上的 git.exe 推导 Git 安装根(<install>\\{cmd,bin,mingw64\\bin}\\git.exe → 上溯)。 */
function deriveGitRootFromPath(): string | null {
  const found = spawnSync("where", ["git.exe"], { encoding: "utf-8", timeout: 5000, windowsHide: true });
  if (found.status !== 0 || !found.stdout) return null;
  for (const line of found.stdout.trim().split(/\r?\n/)) {
    const p = line.trim();
    if (!p) continue;
    // <root>\\cmd\\git.exe 或 <root>\\mingw64\\bin\\git.exe → 上溯到含 usr/bin 的根
    let dir = dirname(p);
    for (let hops = 0; hops < 3; hops++) {
      if (existsSync(join(dir, "usr", "bin", "bash.exe"))) return dir;
      dir = dirname(dir);
    }
  }
  return null;
}

function resolveGitRoot(src: string | null): string {
  const candidates = [
    src,
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git") : null,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Git") : null,
    deriveGitRootFromPath(),
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if (existsSync(join(c, "usr", "bin", "bash.exe"))) return c;
  }
  throw new Error(
    "找不到 Git for Windows 安装根(需含 usr/bin/bash.exe)。请用 --src 指定,如 --src \"D:\\SoftWare\\Git\"",
  );
}

/** 用 ldd 递归求一组 exe 的完整 msys dll 闭包。 */
function collectDllClosure(gitRoot: string, exes: string[]): Set<string> {
  const usrBin = join(gitRoot, "usr", "bin");
  const dlls = new Set<string>();
  const ldd = join(usrBin, "ldd.exe");
  if (!existsSync(ldd)) throw new Error(`ldd.exe 不在 ${usrBin},无法求 dll 闭包`);
  for (const exe of exes) {
    const exePath = join(usrBin, exe);
    if (!existsSync(exePath)) continue; // 脚本(无 .exe)跳过
    const res = spawnSync(ldd, [exePath], { encoding: "utf-8", timeout: 10000 });
    const out = String(res.stdout ?? "");
    for (const m of out.matchAll(/msys-[a-z0-9._-]*\.dll/gi)) dlls.add(m[0]);
  }
  return dlls;
}

function sha256File(path: string): string {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main() {
  if (process.platform !== "win32") {
    console.log("[bash-bundle] 非 Windows,内嵌 bash 仅 Windows 用,跳过(产物需在有 Git 的 Windows 上生成)。");
    return;
  }
  const { src, force } = parseArgs();
  const gitRoot = resolveGitRoot(src);
  console.log(`[bash-bundle] 源: ${gitRoot}`);

  // 幂等:版本戳的 msys2 版本与源一致且产物在 → 跳过(除非 --force)。
  const stampPath = join(gitRoot, "usr", "bin", "msys-2.0.dll");
  const msysMtime = statSync(stampPath).mtimeMs;
  if (!force && existsSync(OUT_BUNDLE) && existsSync(OUT_VERSION)) {
    const prev = JSON.parse(readFileSync(OUT_VERSION, "utf-8"));
    if (prev.msys2MtimeMs === msysMtime) {
      console.log(`[bash-bundle] 版本戳匹配(msys2 mtime ${msysMtime}),已是最新,跳过。--force 强制重打。`);
      return;
    }
  }

  // 1. 求 dll 闭包
  const dlls = [...collectDllClosure(gitRoot, TOOLS)].sort();
  console.log(`[bash-bundle] 工具 ${TOOLS.length} 个,dll 闭包 ${dlls.length} 个: ${dlls.join(", ")}`);

  // 2. 摆 staging:usr/bin/ 平铺(exe + dll + 脚本),根放 LICENSE/NOTICE + etc/fstab
  rmSync(STAGING_DIR, { recursive: true, force: true });
  const stageBin = join(STAGING_DIR, "usr", "bin");
  mkdirSync(stageBin, { recursive: true });
  const usrBin = join(gitRoot, "usr", "bin");
  let copied = 0;
  for (const tool of TOOLS) {
    const from = join(usrBin, tool);
    if (!existsSync(from)) { console.warn(`  [warn] 源缺 ${tool},跳过`); continue; }
    copyFileSync(from, join(stageBin, tool));
    copied++;
  }
  for (const dll of dlls) {
    copyFileSync(join(usrBin, dll), join(stageBin, dll));
    copied++;
  }
  // 合规:Git for Windows / MSYS2 GPL-2.0,嵌入第三方应用需附带许可证文本。
  copyFileSync(join(gitRoot, "LICENSE.txt"), join(STAGING_DIR, "LICENSE.txt"));
  // MSYS2 启动自检需要 /tmp 是"有效目录"。它经 <root>/etc/fstab 的挂载表解析 /tmp
  // (不是 usr/etc,也不扫磁盘 usr/tmp)。照系统 Git 的 etc/fstab 写 usertemp 行:
  // /tmp → 当前用户 Temp 目录,告警消除且 mktemp / tar 落临时文件可用,行为与系统 Git 逐字节对齐。
  const stageEtc = join(STAGING_DIR, "etc");
  mkdirSync(stageEtc, { recursive: true });
  writeFileSync(
    join(stageEtc, "fstab"),
    [
      "# Minimal mount table for the embedded bash runtime (mirrors Git for Windows).",
      "none / cygdrive binary,posix=0,noacl,user 0 0",
      "none /tmp usertemp binary,posix=0,noacl 0 0",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(STAGING_DIR, "NOTICE.txt"),
    [
      "Embedded minimal bash runtime for RikkaHub PC (Windows).",
      "Subset of Git for Windows / MSYS2 (bash + coreutils + runtime DLLs).",
      "Source & license: https://gitforwindows.org/  (GPL-2.0; see LICENSE.txt).",
      "This bundle ships only the shell interpreter and core utilities the AI agent",
      "needs to execute commands; it is not a full Git distribution.",
      "",
    ].join("\n"),
  );
  console.log(`[bash-bundle] staging 就绪: ${copied} 个文件 + LICENSE/NOTICE`);

  // 3. 打成 tar.gz(Bun.Archive 解压端认这个)。用系统原生 bsdtar(C:\Windows\System32\tar.exe)
  //    而非 MSYS2 tar——后者把 "D:\..." 的盘符冒号误当远程 host:path 分隔符(Cannot connect)。
  //    bsdtar 吃纯 Windows 路径,保留 +x 位。
  const listing = readdirSync(stageBin).sort();
  const systemTar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  const tarRes = spawnSync(
    systemTar, ["-czf", OUT_BUNDLE, "-C", STAGING_DIR, "LICENSE.txt", "NOTICE.txt", "etc", "usr"],
    { encoding: "utf-8", windowsHide: true },
  );
  if (tarRes.status !== 0) throw new Error(`tar 打包失败: ${tarRes.stderr}`);
  const sizeMb = (statSync(OUT_BUNDLE).size / 1024 / 1024).toFixed(1);
  console.log(`[bash-bundle] 产物 ${OUT_BUNDLE} (${sizeMb} MB, usr/bin ${listing.length} 项)`);

  // 4. 版本戳(进 git):runtime 据此判定"嵌入的是哪一版",落地覆盖/复用。
  const manifest = {
    bundleVersion: `msys2-${msysMtime}`,           // 以 msys-2.0.dll 的 mtime 作版本指纹
    msys2MtimeMs: msysMtime,
    fileCount: copied,
    sha256: sha256File(OUT_BUNDLE),
    tools: TOOLS,
    dlls,
    builtAt: new Date().toISOString(),
  };
  writeFileSync(OUT_VERSION, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`[bash-bundle] 版本戳 ${OUT_VERSION} (bundleVersion=${manifest.bundleVersion})`);
  console.log(`[bash-bundle] 完成。下一步:bun run compile(自动嵌入 tar.gz 进 exe)。`);
}

main().catch((err) => {
  console.error("[bash-bundle] 失败:", err instanceof Error ? err.message : err);
  process.exit(1);
});
