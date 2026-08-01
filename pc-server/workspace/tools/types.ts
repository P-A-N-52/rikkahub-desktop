// workspace/tools/types.ts — 移植层的工具契约(pi 工具执行内核在 PC 侧的最小公共形状)
// pi 的 AgentTool 携带 TUI 渲染与 TypeBox schema;PC 只取 execute 内核,schema 用
// OpenAI JSON Schema 形状(与 tools/definitions.ts 生态一致),渲染交给 web-ui(M2)。

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolImageContent {
  type: "image";
  /** base64(不带 data: 前缀,与 pi ImageContent 一致) */
  data: string;
  mimeType: string;
}

export type WorkspaceToolContent = ToolTextContent | ToolImageContent;

export interface WorkspaceToolOutput<TDetails = unknown> {
  content: WorkspaceToolContent[];
  details?: TDetails;
}

/** bash 执行中吐部分输出用(pi onUpdate 语义:每次给全量快照,非增量)。 */
export type WorkspaceToolUpdate = (partial: WorkspaceToolOutput<unknown>) => void;

export interface WorkspaceToolDefinition<TArgs, TDetails = unknown> {
  name: string;
  /** pi 原文工具描述(进模型的 tools 声明) */
  description: string;
  /** OpenAI function.parameters 形状的 JSON Schema */
  parameters: Record<string, unknown>;
  execute(args: TArgs, signal?: AbortSignal, onUpdate?: WorkspaceToolUpdate): Promise<WorkspaceToolOutput<TDetails>>;
}
