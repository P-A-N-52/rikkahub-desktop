// conversations/generation-state.ts — 会话生成中的运行时状态（AbortController 注册表）
// 单独成文件：api/sse 与编排层都要读它，独立后互不成环。

export const generating = new Map<string, AbortController>();

/** 压缩进行中的会话(服务端权威;内测反馈:切页后压缩状态丢失)。compress 端点
 *  开始/结束时维护,SSE 连接建立时据此补发 engine-status 快照——engine-status
 *  帧本身是瞬态语义(重连即重置),没有这份快照,切页回来状态条就永远空着,用户
 *  误以为压缩被取消(实际 SPA 内切路由不断 fetch,压缩照常跑完)。 */
export const compressing = new Set<string>();
