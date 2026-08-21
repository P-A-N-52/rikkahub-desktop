// pi-engine/session-files.ts — pi 会话 jsonl(引擎工作记忆)的文件策略(P2)
//
// 双表征持久化(方案 §4.6):SQLite 是 UI/历史唯一事实源;jsonl 是 pi 引擎的工作记忆
// (续会话/压缩/分支的原料),丢失只降级引擎记忆、绝不伤 UI 历史。
//
// 路径策略:pc-data/pi-agent/sessions/<conversationId>.jsonl——确定性命名,会话与
// 工作记忆一一对应;列 pi_session_file 只存文件名(不存绝对路径,pc-data 可搬迁)。
//
// 本模块纪律:纯文件名/路径/清理策略,零 pi 导入——会话删除级联(conversations/helpers)
// 走这里,生产模块图在 P3 路由切换前不引入 pi 树。SessionManager 装配在 runner.ts。

import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { piSessionsDir } from "../foundation/paths";

export { piSessionsDir };

/** 会话 → jsonl 文件名(确定性)。列里存的就是它。 */
export function piSessionFileNameFor(conversationId: string): string {
  return `${conversationId}.jsonl`;
}

/** 文件名 → 绝对路径。basename 收紧:列值只允许纯文件名,路径分隔符一律剥掉
 *  (自家 DB 本可信,但这层是搬迁/导入外部备份后的防线,成本为零)。 */
export function resolvePiSessionPath(fileName: string): string {
  return join(piSessionsDir, basename(fileName));
}

/** fork 复制引擎记忆(P5 裁决:引擎记忆随 fork 走,独立副本杜绝双会话共写同一 jsonl
 *  的互相污染)。引擎记忆是"工作上下文"语义(重新生成/编辑重发同样只追加不回退),
 *  不按 fork 点截断——与 UI 历史按 fork 点截断的差异可容忍。源缺失/复制失败返回
 *  null = 分支从全新引擎记忆开始(UI 历史完整,与损坏降级同语义)。 */
export function copyPiSessionFileForFork(
  sourceFileName: string | null | undefined,
  targetConversationId: string,
): string | null {
  if (!sourceFileName) return null;
  const sourcePath = resolvePiSessionPath(sourceFileName);
  if (!existsSync(sourcePath)) return null;
  const targetName = piSessionFileNameFor(targetConversationId);
  try {
    copyFileSync(sourcePath, resolvePiSessionPath(targetName));
    return targetName;
  } catch {
    return null;
  }
}

/** 隔离损坏的 jsonl:改名 `.corrupt-<ts>` 留证。改名失败(文件锁)退而求删,
 *  保住"新会话可在原路径重建"的主语义。返回隔离件路径(删除兜底时为 null)。 */
export function quarantineCorruptPiSession(path: string): string | null {
  const quarantinedPath = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, quarantinedPath);
    return quarantinedPath;
  } catch {
    try { unlinkSync(path); } catch { /* 尽力而为:两者都失败时由上层 open 再次抛错 */ }
    return null;
  }
}

/** 删除会话级联:清掉对应 jsonl(损坏隔离件不清——隔离件本就是留给用户取证的)。
 *  尽力而为:文件锁/已不存在都不算错,不阻断会话删除主流程。 */
export function deletePiSessionFiles(fileNames: Array<string | null | undefined>): void {
  for (const name of fileNames) {
    if (!name) continue;
    const path = resolvePiSessionPath(name);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // Windows 文件锁等:留给下次删除/手动清理。
    }
  }
}
