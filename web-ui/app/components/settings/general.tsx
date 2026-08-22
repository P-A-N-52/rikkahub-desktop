// components/settings/general.tsx — 通用设置分区（纯搬迁自 routes/settings.tsx）

import * as React from "react";
import { useTranslation } from "react-i18next";
import { UserRound } from "lucide-react";
import { toast } from "sonner";
import { AvatarCropper } from "~/components/avatar-cropper";
import { FontPickerPair } from "~/components/font-picker";
import { CHAT_CJK_OVERRIDE_FAMILY, UI_CJK_OVERRIDE_FAMILY } from "~/lib/font-chain";
import { useAutosaveDraft } from "~/hooks/use-autosave-draft";
import { KeybindingSettings } from "~/components/keybinding-settings";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Separator } from "~/components/ui/separator";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import api from "~/services/api";
import type { AssistantAvatar, Settings } from "~/types";
import { SectionHeader, textValue } from "~/components/settings/shared";
import { isWindowsPlatform, getSystemInfo } from "~/lib/system-info";
import { extractErrorMessage } from "~/lib/error";

export function GeneralSection({
  settings,
  onSettings,
}: {
  settings: Settings;
  onSettings: (settings: Settings) => void;
}) {
  const { t } = useTranslation();
  const display = settings.displaySetting;
  const [name, setName] = React.useState(textValue(display.userNickname));
  const [avatar, setAvatar] = React.useState<AssistantAvatar>(
    display.userAvatar ?? { type: "dummy" },
  );
  const [saving, setSaving] = React.useState(false);
  // R8-2:防抖自动保存统一走共享三件套 hook(保存窗口内键击不丢,语义见 hook 文件头)。
  const autosave = useAutosaveDraft(
    async () => {
      setSaving(true);
      try {
        await patchDisplay({ userNickname: name.trim(), userAvatar: avatar });
      } finally {
        setSaving(false);
      }
    },
    { delayMs: 600, onSaveError: (error) => console.warn('Profile auto-save failed', error) },
  );

  // --- 窗口行为(最小化到托盘 / 退出)—— 仅 Tauri 桌面端渲染 ---
  // 该设置存在 Rust 侧的 user-config.json(跟数据目录同处),不走后端 API/SSE,
  // 因为窗口关闭的瞬间需要 Rust 直接读到它,而不是等前端回传。
  const [tauriReady, setTauriReady] = React.useState(false);
  const [minimizeToTray, setMinimizeToTray] = React.useState(true);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
      setTauriReady(true);
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        const v = await invoke<boolean>("get_minimize_to_tray");
        if (!cancelled) setMinimizeToTray(v);
      } catch (err) {
        console.warn("[tray] get_minimize_to_tray failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // --- 终端(bash)路径:仅 Windows 渲染(Linux/Mac 用系统 shell,无此设置) ---
  // shellPath 是机器级绝对路径,存后端 settings(走 SSE 同步);输入框本地受控,
  // 提交(失焦/回车)才 POST。后端校验 .exe + existsSync,失败 toast 并回滚到上次值。
  const [isWindows, setIsWindows] = React.useState(isWindowsPlatform());
  const [shellPath, setShellPath] = React.useState(settings.shellPath ?? "");
  const [shellBusy, setShellBusy] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    void getSystemInfo().then(() => {
      if (!cancelled) setIsWindows(isWindowsPlatform());
    });
    return () => {
      cancelled = true;
    };
  }, []);
  // SSE 推送/外部改动时同步回输入框(用户没在编辑时)。
  React.useEffect(() => {
    setShellPath(settings.shellPath ?? "");
  }, [settings.shellPath]);

  const submitShellPath = async () => {
    const trimmed = shellPath.trim();
    if (trimmed === (settings.shellPath ?? "")) return; // 无变化不打扰
    setShellBusy(true);
    try {
      await api.post("settings/shell-path", { shellPath: trimmed });
      onSettings({ ...settings, shellPath: trimmed });
      toast.success(t("settings:general.shell_recheck_ok"));
    } catch (err) {
      setShellPath(settings.shellPath ?? ""); // 回滚
      toast.error(extractErrorMessage(err, t("settings:general.shell_path_invalid")));
    } finally {
      setShellBusy(false);
    }
  };

  // 界面字号滑块的本地镜像值。受控 Slider 的 value 若等 POST→SSE 往返才更新,松手时 thumb 会
  // 被旧 value 弹回(用户体验为"拖过去又弹回来")。改用:onValueChange 只动本地(立即跟随),
  // onValueCommit(松手)才提交后端。display 变化时(重置按钮 / SSE 推送)同步回本地。
  const uiFontSizeValue = display.uiFontSize ?? 1;
  const [uiFontSlider, setUiFontSlider] = React.useState(uiFontSizeValue);
  React.useEffect(() => {
    setUiFontSlider(uiFontSizeValue);
  }, [uiFontSizeValue]);

  React.useEffect(() => {
    // 编辑中(含保存窗口内的键击)不让 settings 回环覆盖输入(R8-2 病根)。
    if (autosave.isDirty()) return;
    setName(textValue(display.userNickname));
    setAvatar(display.userAvatar ?? { type: "dummy" });
  }, [display.userNickname, display.userAvatar]);

  const patchDisplay = async (patch: Record<string, unknown>) => {
    const nextDisplay = { ...settings.displaySetting, ...patch };
    await api.post("settings/display", nextDisplay);
    onSettings({ ...settings, displaySetting: nextDisplay });
  };


  return (
    <>
      <SectionHeader
        icon={UserRound}
        title={t("settings:general.title")}
        subtitle={t("settings:general.subtitle")}
      />
      <div className="grid gap-6">
        <div className="space-y-4 rounded-lg border bg-card p-5">
          <AvatarCropper
            value={avatar}
            fallbackName={name || "User"}
            onChange={async (nextAvatar) => {
              setAvatar(nextAvatar);
              const nextDisplay = {
                ...settings.displaySetting,
                userNickname: name.trim(),
                userAvatar: nextAvatar,
              };
              await api.post("settings/display", nextDisplay);
              onSettings({ ...settings, displaySetting: nextDisplay });
            }}
          />
          <Separator />
          <label className="block space-y-2">
            <span className="text-sm font-medium">{t("settings:general.nickname")}</span>
            <Input
              value={name}
              onChange={(event) => {
                autosave.markDirty();
                setName(event.target.value);
              }}
            />
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <FontPickerPair
              label={t("settings:general.ui_font")}
              enValue={textValue(display.uiFontFamily)}
              cjkValue={textValue(display.uiFontFamilyCjk)}
              fallbackFamily={
                '"Noto Sans SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif'
              }
              cjkOverrideFamily={UI_CJK_OVERRIDE_FAMILY}
              onChangeEn={(value, family) =>
                void patchDisplay({ uiFontFamily: value, uiFontFamilyCss: family })
              }
              onChangeCjk={(value, family) =>
                void patchDisplay({ uiFontFamilyCjk: value, uiFontFamilyCjkCss: family })
              }
            />
            {/* 预览兜底固定为默认链,不跟随界面字体——否则改界面字体时对话预览块跟着变,
                用户会误以为两个设置联动(内测反馈)。未设对话字体时实际聊天区仍继承界面字体。 */}
            <FontPickerPair
              label={t("settings:general.chat_font")}
              enValue={textValue(display.chatFontFamily)}
              cjkValue={textValue(display.chatFontFamilyCjk)}
              fallbackFamily={
                '"Noto Sans SC", "Microsoft YaHei", ui-sans-serif, system-ui, sans-serif'
              }
              cjkOverrideFamily={CHAT_CJK_OVERRIDE_FAMILY}
              onChangeEn={(value, family) =>
                void patchDisplay({ chatFontFamily: value, chatFontFamilyCss: family })
              }
              onChangeCjk={(value, family) =>
                void patchDisplay({ chatFontFamilyCjk: value, chatFontFamilyCjkCss: family })
              }
            />
          </div>
          <div className="block space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t("settings:general.ui_font_size")}</span>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {Math.round(uiFontSlider * 100)}%
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={(display.uiFontSize ?? null) === null}
                  onClick={() => void patchDisplay({ uiFontSize: null })}
                >
                  {t("settings:general.reset")}
                </Button>
              </div>
            </div>
            <Slider
              value={[uiFontSlider]}
              min={0.85}
              max={1.8}
              step={0.01}
              aria-label={t("settings:general.ui_font_size")}
              onValueChange={(value) => setUiFontSlider(value[0])}
              onValueCommit={(value) => {
                const next = value[0];
                // 1.00 视为"默认",存 null 以保持根字号完全等同于浏览器默认,
                // 避免任何浮点误差引入的默认态视觉偏差。
                const normalized = Math.abs(next - 1) < 0.001 ? null : Number(next.toFixed(2));
                void patchDisplay({ uiFontSize: normalized });
              }}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings:general.ui_font_size_hint")}
            </p>
          </div>
          <div className="rounded-md border px-3 py-3">
            <KeybindingSettings />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {[
              ["showUserAvatar", "settings:general.opt.show_user_avatar"],
              ["showAssistantBubble", "settings:general.opt.show_assistant_bubble"],
              ["showModelIcon", "settings:general.opt.show_model_icon"],
              ["showModelName", "settings:general.opt.show_model_name"],
              ["showTokenUsage", "settings:general.opt.show_token_usage"],
              ["showThinkingContent", "settings:general.opt.show_thinking"],
              ["sendOnEnter", "settings:general.opt.send_on_enter"],
              ["enableAutoScroll", "settings:general.opt.auto_scroll"],
            ].map(([key, labelKey]) => (
              <label
                key={key}
                className="flex items-center justify-between rounded-md border px-3 py-2"
              >
                <span className="text-sm">{t(labelKey)}</span>
                <Switch
                  checked={display[key] !== false}
                  onCheckedChange={(checked) => void patchDisplay({ [key]: checked })}
                />
              </label>
            ))}
          </div>
          <div className="flex justify-end text-xs text-muted-foreground">
            {saving ? t("settings:common.autosaving") : t("settings:common.autosaved")}
          </div>
        </div>
        {tauriReady && (
          <div className="space-y-4 rounded-lg border bg-card p-5">
            <div>
              <h2 className="text-base font-medium">{t("settings:general.tray_title")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("settings:general.tray_desc")}</p>
            </div><label className="flex items-start justify-between gap-4 rounded-md border px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm">{t("settings:general.minimize_to_tray")}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("settings:general.minimize_to_tray_hint")}
                </div>
              </div>
              <Switch
                checked={minimizeToTray}
                onCheckedChange={async (checked) => {
                  // 乐观更新:先改 UI,失败回滚。invoke 走 Tauri command 写 user-config.json。
                  const prev = minimizeToTray;
                  setMinimizeToTray(checked);
                  try {
                    const { invoke } = await import("@tauri-apps/api/core");
                    await invoke("set_minimize_to_tray", { enabled: checked });
                  } catch (err) {
                    setMinimizeToTray(prev);
                    toast.error(t("settings:common.save_failed"));
                    console.warn("[tray] set_minimize_to_tray failed", err);
                  }
                }}
              />
            </label>
            <div className="flex items-center justify-between gap-4 rounded-md border px-3 py-3">
              <div className="min-w-0">
                <div className="text-sm">{t("settings:general.quit_app")}</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {t("settings:general.quit_app_hint")}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    const { exit } = await import("@tauri-apps/plugin-process");
                    await exit(0);
                  } catch (err) {
                    toast.error(t("settings:general.quit_failed"));
                    console.warn("[tray] exit failed", err);
                  }
                }}
              >
                {t("settings:general.quit_app_button")}
              </Button>
            </div>
          </div>
        )}
        {isWindows && (
          <div className="space-y-4 rounded-lg border bg-card p-5">
            <div>
              <h2 className="text-base font-medium">{t("settings:general.shell_title")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("settings:general.shell_path_hint")}</p>
            </div>
            <label className="block space-y-2">
              <span className="text-sm">{t("settings:general.shell_path")}</span>
              <div className="flex items-center gap-2">
                <Input
                  value={shellPath}
                  disabled={shellBusy}
                  placeholder={t("settings:general.shell_path_placeholder")}
                  className="flex-1 font-mono text-xs"
                  onChange={(event) => setShellPath(event.target.value)}
                  onBlur={() => void submitShellPath()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void submitShellPath();
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={shellBusy}
                  onClick={() => void submitShellPath()}
                >
                  {t("settings:general.shell_recheck")}
                </Button>
              </div>
            </label>
          </div>
        )}
      </div>
    </>
  );
}
