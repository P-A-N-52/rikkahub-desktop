import * as React from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { extractErrorMessage } from "~/lib/error";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import { CHAT_CONTAINER, useContainerTabsStore } from "~/stores/container-tabs-store";
import { useWorkspaceStore } from "~/stores/workspace-store";
import type { WorkspaceDto } from "~/types";

// 权限档位下拉(工作区 M2-3):输入框旁,映射到按工具粒度的审批矩阵,
// workspace 级持久化(PATCH workspaces/:id),可随时切换。仅工作区容器内显示。
// 三档语义(与 pc-server/workspace/approval.ts 一致,2026-08-01 改版):
// - confirm_each 询问批准:write/edit/bash 均审批;read 免审
// - balanced 默认权限(新建默认,并记住上次选择):区内写免审,仅危险命令/区外写入审批
// - full_access 完全访问:全部免审,读写不限于区内(系统目录仍硬拒)

type Preset = WorkspaceDto["permissionPreset"];

const PRESETS: Array<{ value: Preset; icon: typeof Shield }> = [
  { value: "confirm_each", icon: ShieldAlert },
  { value: "balanced", icon: Shield },
  { value: "full_access", icon: ShieldCheck },
];

export function WorkspacePermissionPicker({ className }: { className?: string }) {
  const { t } = useTranslation("input");
  const activeTab = useContainerTabsStore((state) => state.activeTab);
  const workspace = useWorkspaceStore((state) =>
    activeTab === CHAT_CONTAINER ? undefined : state.workspaces.find((item) => item.id === activeTab),
  );
  const refresh = useWorkspaceStore((state) => state.refresh);
  const [saving, setSaving] = React.useState(false);

  if (!workspace) return null;

  const current = PRESETS.find((preset) => preset.value === workspace.permissionPreset) ?? PRESETS[1]!;
  const CurrentIcon = current.icon;

  const applyPreset = async (preset: Preset) => {
    if (preset === workspace.permissionPreset || saving) return;
    setSaving(true);
    try {
      await api.patch<{ workspace: WorkspaceDto }>(`workspaces/${workspace.id}`, { permissionPreset: preset });
      await refresh();
    } catch (err) {
      toast.error(extractErrorMessage(err, t("workspace_permission.save_failed")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-8 gap-1 rounded-full px-2.5 text-muted-foreground hover:text-foreground", className)}
          title={t("workspace_permission.title")}
        >
          <CurrentIcon className="size-4" strokeWidth={1.75} />
          <span className="max-w-24 truncate text-xs">{t(`workspace_permission.${current.value}`)}</span>
          <ChevronDown className="size-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        {PRESETS.map(({ value, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => void applyPreset(value)}>
            <Icon className="size-4" strokeWidth={1.75} />
            <div className="min-w-0 flex-1">
              <div className="text-sm">{t(`workspace_permission.${value}`)}</div>
              <div className="text-xs text-muted-foreground">{t(`workspace_permission.${value}_hint`)}</div>
            </div>
            {value === workspace.permissionPreset ? <Check className="size-4 text-primary" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
