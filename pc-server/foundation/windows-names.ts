// foundation/windows-names.ts — Windows 保留设备名(CON/PRN/AUX/NUL/COM1-9/LPT1-9)单源工具组。
//
// 背景(2.0.0 内测问题4):工作区 files/ 下出现名为 nul 的真实文件,Explorer 删除报
// "MS-DOS 功能无效"。成因:Win32 把这些名字在任意目录下都解析为 DOS 设备(CreateFile
// "D:\dir\nul" 打开的是 NUL 设备),但经 NT 命名空间(\\?\ 前缀路径)写入可以绕过该解析,
// 产生普通 Win32 应用(Explorer/cmd/记事本)既看得见又动不了的真实文件。已实证的制造者:
// Bun 运行时的 node:fs 相对路径写入(fs.writeFileSync("nul") 在 cwd 落真文件;Node 本尊
// 与绝对路径写法都走设备)——Node 生态有把 "nul" 当 Windows 版 /dev/null 的常见误用,
// 模型在工作区跑 bun 项目时即可能踩中;其余 NT 直写工具(部分 Rust CLI、WSL)同理。
//
// 防线三层(调用方分布):
//   ①写入阻断 — workspace/boundary.ts(模型工具写/建目录)、workspace/files.ts(重命名)、
//     backup/export.ts(staging 清洗,行为冻结:保留名加 _ 前缀);
//   ②出生点清扫 — workspace/files.ts 的 sweepWorkspaceReservedNameArtifacts
//     (bash 工具执行后 + 每轮生成开始时,对工作区根做顶层清扫,存量残留自愈);
//   ③处置能力 — workspace/files.ts 的文件面板 list/preview/rename/delete 经
//     windowsSafeFsPath 走 NT 路径,保留名残留在面板中可见、可改名、可删除(Explorer 做不到)。

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

/** 裸名或带任意扩展名(nul、nul.txt 都命中),大小写不敏感。与 backup/export.ts 的
 *  staging 清洗规则同源(该处行为冻结:Android 互导契约)。 */
const WINDOWS_RESERVED_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 清扫用的裸名精确集合(小写)。清扫只处置裸名:带扩展名形式(如 nul.txt)在新版 Windows
 *  上可能是合法文件,删除有误伤风险;裸名文件则确定无法被常规 Win32 应用使用。 */
const WINDOWS_RESERVED_BARE_NAMES: ReadonlySet<string> = new Set([
  "con", "prn", "aux", "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

/** 文件名(不含路径)是否为 Windows 保留设备名(裸名或带扩展名)。平台无关的纯判定,
 *  "是否要拦"由调用方按平台语义决定(macOS/Linux 上 nul 是合法文件名)。 */
export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAME_RE.test(name);
}

/**
 * win32 下把绝对路径转为 \\?\ 前缀的 NT 形式——免除 DOS 设备名解析与 MAX_PATH 限制,
 * 使 stat/read/rename/rm 能作用于保留名"真实文件"而非同名设备。其余平台原样返回。
 * \\?\ 路径不做 "."/".." 归一,先 resolve 规范化;已带前缀/相对路径(违反契约)原样返回。
 */
export function windowsSafeFsPath(absolutePath: string): string {
  if (process.platform !== "win32") return absolutePath;
  if (absolutePath.startsWith("\\\\?\\") || !isAbsolute(absolutePath)) return absolutePath;
  const normalized = resolve(absolutePath);
  // UNC 路径(\\server\share)的 NT 长路径形式是 \\?\UNC\server\share
  if (normalized.startsWith("\\\\")) return `\\\\?\\UNC\\${normalized.slice(2)}`;
  return `\\\\?\\${normalized}`;
}

/** 若路径的文件名是保留设备名则返回 NT 安全形式,否则原样。文件面板等"按名操作"场景的
 *  一行式包装:普通名字零改变,保留名字自动走 NT 路径。 */
export function reservedNameSafeFsPath(absolutePath: string): string {
  return isWindowsReservedName(basename(absolutePath)) ? windowsSafeFsPath(absolutePath) : absolutePath;
}

/**
 * 清扫目录顶层的保留裸名残留文件(不递归:残留由在该 cwd 执行的命令产生,顶层即出生点;
 * 深层残留可经文件面板手工处置)。只删文件不删目录(保留名目录从未观测到,递归删除未知
 * 内容风险不对称)。任何单项失败静默跳过——清扫是卫生操作,不得打断业务流。
 * @returns 实际删除的文件名列表(win32 之外恒为空数组)。
 */
export function sweepWindowsReservedNames(dir: string): string[] {
  if (process.platform !== "win32") return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!WINDOWS_RESERVED_BARE_NAMES.has(name.toLowerCase())) continue;
    const safePath = windowsSafeFsPath(join(dir, name));
    try {
      if (!statSync(safePath).isFile()) continue;
      rmSync(safePath, { force: true });
      if (!existsSync(safePath)) removed.push(name);
    } catch {
      // 忽略:并发删除/权限受限等,下次清扫再试
    }
  }
  return removed;
}
