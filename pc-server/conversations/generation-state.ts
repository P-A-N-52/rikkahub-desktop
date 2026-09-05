// conversations/generation-state.ts — 会话生成中的运行时状态（AbortController 注册表）
// 单独成文件：api/sse 与编排层都要读它，独立后互不成环。

export const generating = new Map<string, AbortController>();

/** 压缩进行中的会话 → 开始时刻(epoch ms;服务端权威;内测反馈:切页后压缩状态丢失)。
 *  compress 端点开始/结束时维护,SSE 连接建立时据此补发 engine-status 快照(含
 *  startedAt,"已处理 xx秒"计时跨重连连续)——engine-status 帧本身是瞬态语义(重连
 *  即重置),没有这份快照,切页回来状态条就永远空着,用户误以为压缩被取消(实际
 *  SPA 内切路由不断 fetch,压缩照常跑完)。 */
export const compressing = new Map<string, number>();
