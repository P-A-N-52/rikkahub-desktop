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
}
