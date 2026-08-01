// ===== 流式前缀冻结(2026-08-01,"长会话流式表格/大块时滚动掉到十几帧"的单价根治)=====
//
// 成本模型:流式中每帧都对**全文**跑三趟 O(n)——preProcess 正则、Streamdown remend
// (流式截断修补)、marked 块切分;消息越长每帧越贵,这是掉帧的单价来源(节奏层已由
// conversation-stream 的注意力攒批治理,本模块治单价,两者正交)。
//
// 方案:已完成的顶层块晋升进"冻结前缀"——前缀字符串稳定,前缀 Streamdown 实例被其
// 自身 memo 整树跳过;每帧真正重算的只有活动尾部(最后几块)。块边界用 Streamdown
// 自己导出的 parseMarkdownIntoBlocks 判定,与其内部切分语义完全一致。
//
// 保守锚点(正确性优先于性能):
// - 末 HOLDBACK 块永不晋升:setext 标题、列表/引用惰性延续等"后一行改写前一块"的
//   语法只影响紧邻块,回看 2 块全覆盖。注意 marked 把空行当独立 space token(也计一
//   块),回看 2 块通常=「空行分隔符 + 生长中的末块」——被晋升的最后一个内容块必然
//   已被空行/后继块封口,不可能再被后续输出改写
// - 含脚注时 parseMarkdownIntoBlocks 返回整文单块 → 自然不晋升,退化为旧行为
// - content 不再以已冻结前缀开头(重新生成/编辑消息)→ 清零重来,只损性能不损正确
// - 晋升段的 preProcess 独立执行:围栏代码是单块永不被切开,行内正则不跨块;唯一
//   例外(跨空行的 \[..\] 公式被块边界切开)本就被 Streamdown 的逐块独立渲染破坏,
//   非新增回归。生成结束(isAnimating=false)回归单实例整文渲染,最终呈现与旧实现
//   逐字节一致。
import { parseMarkdownIntoBlocks } from "streamdown";

export interface FrozenPrefix {
  /** 已冻结的原文前缀(content 的字面前缀,块边界对齐)。 */
  raw: string;
  /** 前缀的预处理产物(随晋升增量累积,避免每次晋升重扫整个前缀)。 */
  processed: string;
}

export const EMPTY_FROZEN_PREFIX: FrozenPrefix = { raw: "", processed: "" };

/** 活动尾部超过该长度才尝试晋升:太小则晋升过频(每次晋升要对尾部做一次块切分)。 */
export const STREAM_TAIL_PROMOTE_THRESHOLD = 3072;
/** 永不晋升的尾部块数(见文件头"保守锚点")。 */
export const STREAM_PROMOTE_HOLDBACK_BLOCKS = 2;

/**
 * 纯函数推进:(旧前缀, 最新全文, 预处理器) → 新前缀。
 * 幂等——同一 content 重复推进得到相同结果,渲染期双调(StrictMode)安全。
 */
export function advanceFrozenPrefix(
  previous: FrozenPrefix,
  content: string,
  preProcess: (segment: string) => string,
): FrozenPrefix {
  const base = content.startsWith(previous.raw) ? previous : EMPTY_FROZEN_PREFIX;
  const tail = content.slice(base.raw.length);
  if (tail.length <= STREAM_TAIL_PROMOTE_THRESHOLD) return base;
  const blocks = parseMarkdownIntoBlocks(tail);
  if (blocks.length <= STREAM_PROMOTE_HOLDBACK_BLOCKS) return base;
  const promoted = blocks.slice(0, blocks.length - STREAM_PROMOTE_HOLDBACK_BLOCKS).join("");
  // 防御:块切分保拼接(token.raw 串接)是 marked 的既有行为;若上游漂移导致拼不回
  // 原文,放弃本次晋升——"前缀是 content 字面前缀"的不变式优先于性能。
  if (!tail.startsWith(promoted)) return base;
  return { raw: base.raw + promoted, processed: base.processed + preProcess(promoted) };
}
