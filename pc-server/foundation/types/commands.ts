// foundation/types/commands.ts — 斜杠指令跨端契约(叶子模块,web-ui type-only 消费)
//
// 纪律:web-ui 经 @server 别名只允许 type-only import,且只允许指向 foundation/types
// 下的叶子模块——若直接 type-import commands/registry.ts(运行时模块),tsc 会顺着
// import 图把 engines/runner 等服务端运行时代码整个拖进 web-ui 的类型检查语境。
// 指令定义与可用性矩阵住 commands/registry.ts;这里只放前端可见的 DTO 形状。

/** 指令执行目标:server = 前端调某个既有/专用 REST API;client = 纯前端动作
 *  (如未来 /settings 打开设置页)。注册表只声明目标类型,具体执行器在前端分发表。 */
export type CommandExecutionTarget = "server" | "client";

/** GET /api/commands 下发的可用指令条目(定义中与环境无关的展示/执行字段)。 */
export interface AvailableCommandDto {
  /** 全局唯一名(英文小写,即用户输入的 /name,不翻译)。
   *  前端 i18n key 约定:commands.<name>.description / commands.<name>.argument_hint */
  name: string;
  /** 是否接受参数(/name <参数>)。false 的指令带参数视为普通文本,不拦截。 */
  hasArgument: boolean;
  executionTarget: CommandExecutionTarget;
}
