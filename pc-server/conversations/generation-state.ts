// conversations/generation-state.ts — 会话生成中的运行时状态（AbortController 注册表）
// 单独成文件：api/sse 与编排层都要读它，独立后互不成环。

export const generating = new Map<string, AbortController>();

/** 压缩进行中的会话 → 开始时刻(epoch ms;服务端权威;内测反馈:切页后压缩状态丢失)。
 *  compress 端点开始/结束时维护,SSE 连接建立时据此补发 engine-status 快照(含
 *  startedAt,"已处理 xx秒"计时跨重连连续)——engine-status 帧本身是瞬态语义(重连
 *  即重置),没有这份快照,切页回来状态条就永远空着,用户误以为压缩被取消(实际
 *  SPA 内切路由不断 fetch,压缩照常跑完)。 */
export const compressing = new Map<string, number>();

/** 域4-1(专题-交互审查 2A):审批等待中的会话 → {开始时刻, 工具名, 审批对象摘要}。
 *  与 compressing 同哲学:engine-status 帧是瞬态语义(重连即重置),审批挂起可能跨
 *  切页/失焦存活很久,没有这份注册表,SSE 重连后"等待审批"的琥珀态就丢失、桌面
 *  通知也无从恢复。由 approval-flow.gateToolApproval 在进入/离开等待时维护;
 *  生成终局(finally busy:false)兜底清除。一个会话同时只挂一张审批卡(sequential),
 *  故单值而非集合。 */
export const awaitingApproval = new Map<string, { startedAt: number; toolName?: string; summary?: string }>();
