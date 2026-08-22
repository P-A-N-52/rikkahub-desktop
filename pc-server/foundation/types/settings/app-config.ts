import type { JsonValue } from "..";

export interface AppConfig {
  dynamicColor: boolean;
  themeId: string;
  developerMode: boolean;
  displaySetting: Record<string, JsonValue>;
  preferredPort: number | null;
  /** PC-only:用户上一次选择的工作区权限档位(新建工作区的默认档位记忆);
   *  null = 从未选择过,新建取 balanced(默认权限)。 */
  workspaceLastPermissionPreset: string | null;
  keybindings: Record<string, JsonValue>;
  webServerJwtEnabled: boolean;
  /** PC-only:自定义 bash 可执行文件路径(如 C:\cygwin64\bin\bash.exe)。
   *  空串 = 未指定,getShellConfig 走自动探测(系统 Git Bash → 内嵌兜底)。
   *  机器级绝对路径,导出备份时剥离(PC→APP/跨机无意义,见 backup/export.ts stripPcOnly)。 */
  shellPath?: string;
}
