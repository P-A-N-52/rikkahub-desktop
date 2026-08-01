import * as React from "react";

import { useMutation } from "@tanstack/react-query";
import {
  Brain,
  BrainCircuit,
  ChevronDown,
  Lightbulb,
  LightbulbOff,
  LoaderCircle,
  Sparkles,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { useCurrentAssistant } from "~/hooks/use-current-assistant";
import { useCurrentModel } from "~/hooks/use-current-model";
import { extractErrorMessage } from "~/lib/error";
import { refreshSettingsStore } from "~/lib/settings-sync";
import { cn } from "~/lib/utils";
import api from "~/services/api";
import type { ProviderModel } from "~/types";
import { Slider } from "~/components/ui/slider";

import { PickerErrorAlert } from "./picker-error-alert";

// 思考强度(前端重构A2,用户拍板"模型选择入口与思维强度合一"):不再是输入行的独立
// 按钮,而是模型选择弹层底部的内联折叠区(ReasoningInlineSection)。刻意不用嵌套
// Popover——Radix 外层 dismiss 层对 portal 出去的内层内容判定为"外部点击",嵌套
// 关闭行为不可靠;内联展开无此风险。模型胶囊经 useCurrentReasoningLabel 显示
// "模型名 · 强度"后缀(NewMax 形态)。

type ReasoningLevel = "off" | "auto" | "low" | "medium" | "high" | "xhigh";

const REASONING_LEVELS: ReasoningLevel[] = ["off", "auto", "low", "medium", "high", "xhigh"];

interface ReasoningPreset {
  key: ReasoningLevel;
  label: string;
  description: string;
}

function isReasoningModel(model: ProviderModel | null): boolean {
  if (!model) return false;
  // The model.abilities array is authoritative: backend `enrichModel` infers it on fetch, the
  // startup migration backfills stale state, and the provider settings UI lets users override
  // by hand. Honor the user's choice — don't fall back to an id heuristic that could override
  // an explicit unselect.
  return (model.abilities ?? []).includes("REASONING");
}

function ReasoningIcon({ level, className }: { level: ReasoningLevel; className?: string }) {
  const props = { className: cn("size-4", className) };
  switch (level) {
    case "off":
      return <LightbulbOff {...props} />;
    case "auto":
      return <Sparkles {...props} />;
    case "low":
      return <Lightbulb {...props} />;
    case "medium":
      return <Lightbulb {...props} />;
    case "high":
      return <BrainCircuit {...props} />;
    case "xhigh":
      return <Brain {...props} />;
  }
}

function useReasoningPresets(): ReasoningPreset[] {
  const { t } = useTranslation("input");
  return React.useMemo<ReasoningPreset[]>(
    () =>
      REASONING_LEVELS.map((key) => ({
        key,
        label: t(`reasoning.presets.${key}.label`),
        description: t(`reasoning.presets.${key}.description`),
      })),
    [t],
  );
}

/** 当前思考强度的展示标签;模型不支持推理时返回 null(模型胶囊隐藏后缀)。 */
export function useCurrentReasoningLabel(): string | null {
  const { t } = useTranslation("input");
  const { currentAssistant } = useCurrentAssistant();
  const { currentModel } = useCurrentModel();
  if (!isReasoningModel(currentModel)) return null;
  const level = (currentAssistant?.reasoningLevel as ReasoningLevel | null | undefined) ?? "auto";
  return t(`reasoning.presets.${level}.label`);
}

export interface ReasoningInlineSectionProps {
  disabled?: boolean;
}

/** 模型弹层底部的思考强度折叠区:收起时一行摘要,展开后是原滑杆控件。 */
export function ReasoningInlineSection({ disabled = false }: ReasoningInlineSectionProps) {
  const { t } = useTranslation("input");
  const { currentAssistant } = useCurrentAssistant();
  const { currentModel } = useCurrentModel();
  const reasoningPresets = useReasoningPresets();

  const [expanded, setExpanded] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const canUse = Boolean(currentAssistant && !disabled);
  const canReasoning = isReasoningModel(currentModel);

  const currentLevel =
    (currentAssistant?.reasoningLevel as ReasoningLevel | null | undefined) ?? "auto";
  const currentIndex = Math.max(0, REASONING_LEVELS.indexOf(currentLevel));
  const currentPreset = reasoningPresets.find((p) => p.key === currentLevel) ?? reasoningPresets[1];

  const [localIndex, setLocalIndex] = React.useState(currentIndex);

  React.useEffect(() => {
    setLocalIndex(currentIndex);
  }, [currentIndex]);

  const updateReasoningLevelMutation = useMutation({
    mutationFn: ({
      assistantId,
      reasoningLevel,
    }: {
      assistantId: string;
      reasoningLevel: ReasoningLevel;
    }) =>
      api.post<{ status: string }>("settings/assistant/thinking-budget", {
        assistantId,
        reasoningLevel,
      }),
    onError: (updateError) => {
      setError(extractErrorMessage(updateError, t("reasoning.update_failed")));
      setLocalIndex(currentIndex);
    },
    onSuccess: async () => {
      await refreshSettingsStore();
      setError(null);
    },
  });

  const loading = updateReasoningLevelMutation.isPending;
  const localLevel = REASONING_LEVELS[localIndex] ?? currentLevel;
  const localPreset = reasoningPresets.find((p) => p.key === localLevel) ?? currentPreset;
  const isEnabled = localLevel !== "off";

  if (!canReasoning) return null;

  return (
    <div className="border-t">
      <button
        type="button"
        disabled={!canUse || loading}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex h-10 w-full items-center justify-between px-4 text-sm transition-colors hover:bg-accent disabled:opacity-50"
      >
        <span className="flex items-center gap-2 text-muted-foreground">
          <ReasoningIcon
            level={currentLevel}
            className={cn("size-4", currentLevel !== "off" && "text-primary")}
          />
          {t("reasoning.title")}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {loading ? <LoaderCircle className="size-3.5 animate-spin" /> : currentPreset.label}
          <ChevronDown className={cn("size-3.5 transition-transform", expanded && "rotate-180")} />
        </span>
      </button>

      {expanded ? (
        <div className="space-y-4 px-4 pb-4 pt-1">
          <PickerErrorAlert error={error} />

          <div
            className={cn(
              "min-h-[2.5em] text-center text-xs transition-colors",
              isEnabled ? "text-muted-foreground" : "text-muted-foreground/70",
            )}
          >
            {localPreset.description}
          </div>

          <div className="space-y-2">
            <Slider
              value={[localIndex]}
              min={0}
              max={REASONING_LEVELS.length - 1}
              step={1}
              disabled={disabled || loading}
              onValueChange={([index]) => {
                setLocalIndex(index);
              }}
              onValueCommit={([index]) => {
                if (!currentAssistant) return;
                const level = REASONING_LEVELS[index];
                updateReasoningLevelMutation.mutate({
                  assistantId: currentAssistant.id,
                  reasoningLevel: level,
                });
              }}
            />

            {/* Tick labels — 标签中心精确对齐 Radix 滑块圆头。
                Radix thumb 不在 i/(n-1)*100%(那样端点会溢出轨道),而是做"边界内偏移"
                (getThumbInBoundsOffset):thumb 中心 = i/(n-1) * (容器宽 - thumb直径) + thumb半径。
                thumb 为 size-4(16px),故 6 个停靠点均匀落在 [8px, 100%-8px]。标签用同一 calc
                公式定位,所有档位统一 -translate-x-1/2 中心对齐,圆头严格落在每个文字中心。 */}
            <div className="relative h-3.5">
              {reasoningPresets.map((preset, i) => {
                const last = reasoningPresets.length - 1;
                return (
                  <span
                    key={preset.key}
                    className={cn(
                      "absolute top-0 -translate-x-1/2 text-[0.625rem] leading-none whitespace-nowrap transition-colors",
                      i === localIndex ? "text-primary font-medium" : "text-muted-foreground",
                    )}
                    style={{ left: `calc((100% - 16px) * ${i / last} + 8px)` }}
                  >
                    {preset.label}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
