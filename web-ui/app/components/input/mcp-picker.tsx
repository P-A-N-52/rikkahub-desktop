import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { getDisplayName } from "~/lib/display";
import { extractErrorMessage } from "~/lib/error";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { safeStringArray } from "~/lib/type-guards";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { McpToolOption, McpToolOverride } from "~/types";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Switch } from "~/components/ui/switch";

import { PickerErrorAlert } from "./picker-error-alert";

// MCP 选择器(前端重构A2,用户拍板"MCP和拓展入口合一"):不再是输入行的独立
// Popover 按钮,而是拓展弹层(extension-picker)里 MCP 标签页的内容面板。

export interface McpPanelProps {
  disabled?: boolean;
}

/** 合一入口的徽标数据:已选中且全局启用的 MCP 服务器数 + 是否有可选服务器。 */
export function useMcpBadge(): { count: number; hasServers: boolean } {
  const { settings, currentAssistant } = useCurrentAssistant();
  const allServers = settings?.mcpServers ?? [];
  const enabledServerIdSet = React.useMemo(
    () =>
      new Set(
        allServers
          .filter((server) => server.commonOptions?.enable)
          .map((server) => server.id),
      ),
    [allServers],
  );
  const selectedServerIds = React.useMemo(
    () => safeStringArray(currentAssistant?.mcpServers),
    [currentAssistant?.mcpServers],
  );
  const count = React.useMemo(
    () => selectedServerIds.filter((serverId) => enabledServerIdSet.has(serverId)).length,
    [enabledServerIdSet, selectedServerIds],
  );
  return { count, hasServers: enabledServerIdSet.size > 0 };
}

function getEnabledToolsCount(tools: McpToolOption[] | undefined): {
  enabled: number;
  total: number;
} {
  if (!tools || tools.length === 0) {
    return { enabled: 0, total: 0 };
  }

  const total = tools.length;
  const enabled = tools.filter((tool) => tool.enable).length;
  return { enabled, total };
}

function McpPanelImpl({ disabled = false }: McpPanelProps) {
  const { t } = useTranslation("input");
  const { settings, currentAssistant } = useCurrentAssistant();

  const canUse = Boolean(settings && currentAssistant && !disabled);
  const [error, setError] = React.useState<string | null>(null);

  const allServers = settings?.mcpServers ?? [];
  const knownServerIdSet = React.useMemo(
    () => new Set(allServers.map((server) => server.id)),
    [allServers],
  );
  const enabledServers = React.useMemo(
    () => allServers.filter((server) => server.commonOptions?.enable),
    [allServers],
  );

  const selectedServerIds = React.useMemo(
    () => safeStringArray(currentAssistant?.mcpServers),
    [currentAssistant?.mcpServers],
  );

  const selectedServerIdSet = React.useMemo(() => new Set(selectedServerIds), [selectedServerIds]);

  const updateMcpMutation = useMutation({
    mutationFn: ({
      nextServerIds,
      assistantId,
    }: {
      nextServerIds: string[];
      assistantId: string;
      serverId: string;
    }) =>
      api.post<{ status: string }>("settings/assistant/mcp", {
        assistantId,
        mcpServerIds: nextServerIds,
      }),
    onError: (updateError) => {
      setError(extractErrorMessage(updateError, t("mcp.update_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const handleToggleServer = React.useCallback(
    (serverId: string, enabled: boolean) => {
      if (!canUse || !currentAssistant) {
        return;
      }

      const nextServerIds = new Set(
        selectedServerIds.filter((selectedServerId) => knownServerIdSet.has(selectedServerId)),
      );

      if (enabled) {
        nextServerIds.add(serverId);
      } else {
        nextServerIds.delete(serverId);
      }

      updateMcpMutation.mutate({
        nextServerIds: Array.from(nextServerIds),
        assistantId: currentAssistant.id,
        serverId,
      });
    },
    [canUse, currentAssistant, knownServerIdSet, selectedServerIds, updateMcpMutation],
  );

  // Per-tool override mutation. The backend persists `null` as "clear override (revert to
  // global default)" — the React Query mutation just forwards the body as-is.
  const updateToolOverrideMutation = useMutation({
    mutationFn: (payload: {
      assistantId: string;
      serverId: string;
      toolName: string;
      enable?: boolean | null;
      needsApproval?: boolean | null;
    }) => api.post<{ status: string }>("settings/assistant/mcp-tool-override", payload),
    onError: (overrideError) => {
      setError(extractErrorMessage(overrideError, t("mcp.update_failed")));
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  // Per-server expand/collapse state. Default collapsed. Tracking by server id since servers
  // get reordered/removed independent of the user's expand state.
  const [expandedServerIds, setExpandedServerIds] = React.useState<Set<string>>(new Set());
  const toggleExpand = (serverId: string) => {
    setExpandedServerIds((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) next.delete(serverId);
      else next.add(serverId);
      return next;
    });
  };

  // Read current assistant's override for one (server, tool). Returns the override entry or
  // an empty object so callers can do `override.enable ?? true` style fallbacks.
  const getOverride = (serverId: string, toolName: string): McpToolOverride => {
    const overrides = currentAssistant?.mcpToolOverrides as
      | Record<string, Record<string, McpToolOverride>>
      | undefined;
    return overrides?.[serverId]?.[toolName] ?? {};
  };

  return (
    <div className="space-y-2">
      <PickerErrorAlert error={error} />

      <ScrollArea className="h-[16rem] pr-1.5">
            {enabledServers.length > 0 ? (
              <div className="space-y-1">
                {enabledServers.map((server) => {
                  const selected = selectedServerIdSet.has(server.id);
                  const switching =
                    updateMcpMutation.isPending &&
                    updateMcpMutation.variables?.serverId === server.id;
                  const toolCount = getEnabledToolsCount(server.commonOptions?.tools);
                  const expanded = expandedServerIds.has(server.id);
                  // Only globally-enabled tools surface here. A tool with global enable=false
                  // is invisible to the user in this picker — matching the rule "设置中关闭的
                  // 工具会话里看不见". The per-assistant override only refines among the
                  // globally-enabled set.
                  const visibleTools: McpToolOption[] = (server.commonOptions?.tools ?? []).filter(
                    (tool) => tool.enable !== false,
                  );

                  return (
                    <div
                      key={server.id}
                      className={cn(
                        "rounded-md border transition",
                        selected && "border-primary bg-primary/5",
                      )}
                    >
                      <div className="flex items-center gap-1.5 px-2 py-1.5">
                        <button
                          type="button"
                          onClick={() => toggleExpand(server.id)}
                          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground hover:text-foreground"
                          aria-label={expanded ? "收起" : "展开"}
                          disabled={visibleTools.length === 0}
                          title={
                            visibleTools.length === 0
                              ? "暂无可用工具"
                              : expanded
                                ? "收起工具列表"
                                : "展开工具列表"
                          }
                        >
                          {switching ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : expanded ? (
                            <ChevronDown className="size-3" />
                          ) : (
                            <ChevronRight className="size-3" />
                          )}
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="truncate text-mini font-medium leading-tight">
                            {getDisplayName(server.commonOptions?.name, t("mcp.unnamed_server"))}
                          </div>
                          <div className="text-muted-foreground text-micro leading-tight">
                            {t("mcp.tools_enabled", {
                              enabled: toolCount.enabled,
                              total: toolCount.total,
                            })}
                          </div>
                        </div>

                        <Switch
                          size="sm"
                          checked={selected}
                          disabled={disabled || updateMcpMutation.isPending}
                          onCheckedChange={(nextChecked) => {
                            handleToggleServer(server.id, nextChecked);
                          }}
                        />
                      </div>

                      {expanded && visibleTools.length > 0 ? (
                        // Per-tool override panel. The rule for each tool's `enable` state:
                        //   global=true & no override          → checked (default behavior)
                        //   global=true & override.enable=false → unchecked (assistant disabled)
                        //   global=true & override.enable=true  → checked (explicit, same as default)
                        // We send `null` to the backend to clear an override (restore default).
                        //
                        // Master/child semantics: when the assistant has the MCP server master
                        // OFF (`!selected`), the per-tool switches stay visible AND show their
                        // last preference, but are read-only & greyed — toggling the server
                        // back on will revive whatever the user had configured.
                        <div
                          className={cn(
                            "border-t bg-muted/30 px-2 py-1.5 space-y-1",
                            !selected && "opacity-60",
                          )}
                        >
                          {visibleTools.map((tool) => {
                            const override = getOverride(server.id, tool.name);
                            const effectiveEnabled = override.enable !== false;
                            const effectiveNeedsApproval =
                              typeof override.needsApproval === "boolean"
                                ? override.needsApproval
                                : tool.needsApproval === true;
                            const isMutating =
                              updateToolOverrideMutation.isPending &&
                              updateToolOverrideMutation.variables?.serverId === server.id &&
                              updateToolOverrideMutation.variables?.toolName === tool.name;
                            return (
                              <div
                                key={tool.name}
                                className="flex items-center gap-1.5 rounded px-1 py-1"
                              >
                                <div className="min-w-0 flex-1">
                                  <div
                                    className="truncate text-mini leading-tight"
                                    title={tool.name}
                                  >
                                    {tool.name}
                                  </div>
                                </div>
                                {isMutating ? (
                                  <LoaderCircle className="size-3 animate-spin text-muted-foreground" />
                                ) : null}
                                <label className="flex items-center gap-1 text-micro text-muted-foreground">
                                  <span>需要用户审核</span>
                                  <Switch
                                    size="sm"
                                    checked={effectiveNeedsApproval}
                                    disabled={disabled || !currentAssistant || !selected}
                                    onCheckedChange={(nextChecked) => {
                                      if (!currentAssistant) return;
                                      // If the toggle matches the global default, clear the
                                      // override (send null) to keep state minimal. Otherwise
                                      // store the explicit override.
                                      const matchesGlobal =
                                        nextChecked === (tool.needsApproval === true);
                                      updateToolOverrideMutation.mutate({
                                        assistantId: currentAssistant.id,
                                        serverId: server.id,
                                        toolName: tool.name,
                                        needsApproval: matchesGlobal ? null : nextChecked,
                                      });
                                    }}
                                  />
                                </label>
                                <label className="flex items-center gap-1 text-micro text-muted-foreground">
                                  <span>启用</span>
                                  <Switch
                                    size="sm"
                                    checked={effectiveEnabled}
                                    disabled={disabled || !currentAssistant || !selected}
                                    onCheckedChange={(nextChecked) => {
                                      if (!currentAssistant) return;
                                      // enable=true is the global default → clear the override.
                                      // enable=false → explicit override to disable for this assistant.
                                      updateToolOverrideMutation.mutate({
                                        assistantId: currentAssistant.id,
                                        serverId: server.id,
                                        toolName: tool.name,
                                        enable: nextChecked ? null : false,
                                      });
                                    }}
                                  />
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="rounded-md border border-dashed px-3 py-8 text-center text-sm text-muted-foreground">
                {t("mcp.empty")}
              </div>
            )}
      </ScrollArea>
    </div>
  );
}

// memo:disabled 在打字时不变,跳过重渲染。
export const McpPanel = React.memo(McpPanelImpl);
