import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n from "~/i18n";
import { getSystemInfoSnapshot, isTauriEnvironment } from "~/lib/system-info";
import api from "~/services/api";
import { useSettingsStore } from "~/stores/app-store";
import type { DisplaySetting } from "~/types";

export type ThemeMode = "dark" | "light" | "system";
export type Theme = ThemeMode;

// 所有内置预置主题的 data-theme 值。新增预置主题时:在 app.css 写对应的
// :root[data-theme="..."] / :root.dark[data-theme="..."] 变量块,再在这里登记,
// 然后到 conversation-sidebar 的 COLOR_THEME_OPTIONS 加选项。
export const BUILTIN_COLOR_THEMES: readonly string[] = [
  "default",
  "mono",
  "claude",
  "claude-plus",
  "vermillion",
  "amber-mono",
  "mx-brutalist",
  "tiesen",
  "vescrow",
];

// colorTheme 是内置主题名(default/claude/mono)或用户主题的 id("user-xxx"),所以用 string。
export type ColorTheme = string;

export type CustomThemeCss = {
  light: string;
  dark: string;
};

// 一条用户自定义主题。id 同时作为 data-theme 的值,CSS 注入时按它做作用域隔离,
// 因此多个自定义主题可以并存、互不污染,切换时只有被选中的那条生效。
export type UserTheme = {
  id: string;
  name: string;
  css: CustomThemeCss;
};

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: ThemeMode;
  defaultColorTheme?: ColorTheme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  colorTheme: ColorTheme;
  setColorTheme: (theme: ColorTheme) => void;
  userThemes: UserTheme[];
  addUserTheme: (data: { name: string; css: CustomThemeCss }) => UserTheme;
  updateUserTheme: (id: string, patch: { name?: string; css?: CustomThemeCss }) => void;
  deleteUserTheme: (id: string) => void;
};

const initialState: ThemeProviderState = {
  theme: "system",
  colorTheme: "default",
  userThemes: [],
  setTheme: () => null,
  setColorTheme: () => null,
  addUserTheme: () => ({ id: "", name: "", css: { light: "", dark: "" } }),
  updateUserTheme: () => null,
  deleteUserTheme: () => null,
};

const ThemeProviderContext = createContext<ThemeProviderState>(initialState);

const COLOR_THEME_STORAGE_SUFFIX = "-color";
const USER_THEMES_STORAGE_SUFFIX = "-user-themes";
const LEGACY_CUSTOM_LIGHT_SUFFIX = "-custom-light";
const LEGACY_CUSTOM_DARK_SUFFIX = "-custom-dark";
const CUSTOM_THEME_STYLE_ID = "rikkahub-custom-theme";

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark" || value === "system";
}

function generateUserThemeId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function removeBlacklistedCss(value: string): string {
  return value
    .replace(/@theme\s+inline\s*\{[\s\S]*?\}/g, "")
    .replace(/(^|\n)\s*body\s*\{[\s\S]*?\}/g, "")
    .trim();
}

// 把一段用户 CSS 收进 :root[data-theme="<id>"] / :root.dark[data-theme="<id>"] 作用域下,
// 让它只在对应主题被选中时生效,不污染内置主题或其他用户主题。
function scopeCssForTheme(value: string, dataThemeId: string, mode: "light" | "dark"): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const filtered = removeBlacklistedCss(trimmed);
  if (!filtered) return "";
  const scopeAttr = `[data-theme="${dataThemeId}"]`;

  if (mode === "light") {
    const scoped = filtered.replace(
      /(^|\n)\s*:root(?!\.dark)(?!\[data-theme=)\s*\{/g,
      `$1:root${scopeAttr} {`,
    );
    if (/:root\[data-theme=/.test(scoped)) return scoped;
    return `:root${scopeAttr} {\n${filtered}\n}`;
  }

  const scopedDarkRoot = filtered.replace(
    /(^|\n)\s*:root\.dark(?!\[data-theme=)\s*\{/g,
    `$1:root.dark${scopeAttr} {`,
  );
  const scoped = scopedDarkRoot.replace(
    /(^|\n)\s*\.dark(?![a-zA-Z0-9_-])\s*\{/g,
    `$1:root.dark${scopeAttr} {`,
  );
  if (/:root\.dark\[data-theme=/.test(scoped)) return scoped;
  return `:root.dark${scopeAttr} {\n${filtered}\n}`;
}

// ─── 持久化(专题8:重置/遗忘专项) ───────────────────────────────────────
// 主题的权威存储从 localStorage 迁至后端 settings.displaySetting(PC-only 键,
// 导出安卓时剥离,见 pc-server/backup/export.ts pcOnlyDisplayFields)。
// 动机:Tauri 窗口的 origin 是 http://localhost:<端口>,localStorage 按 origin 隔离,
// 用户改端口(或首选端口被占、启动时自动顺延)后自定义主题/明暗模式全部"消失"。
// 首帧同步初值来自 settings 镜像(store 初值,见 lib/settings-mirror.ts),权威快照
// 到达后经 store 订阅校正;旧 localStorage 数据由一次性迁移上传后清除。

type ThemePrefs = {
  mode: ThemeMode;
  colorTheme: ColorTheme;
  userThemes: UserTheme[];
};

function sanitizeUserThemes(raw: unknown): UserTheme[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (item): item is UserTheme =>
      !!item &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      typeof item.css === "object" &&
      item.css !== null &&
      typeof item.css.light === "string" &&
      typeof item.css.dark === "string",
  );
}

// 归一化 colorTheme:兜底已删除的内置主题、旧版 "custom"、以及指向不存在用户主题的脏值。
function resolveColorTheme(stored: unknown, userThemes: UserTheme[], fallback: ColorTheme): ColorTheme {
  if (typeof stored !== "string" || !stored) return fallback;
  // 旧版固定槽 "custom" → 映射到迁移后的第一条用户主题
  if (stored === "custom") return userThemes[0]?.id ?? fallback;
  // 已移除的内置主题
  if (stored === "t3-chat" || stored === "bubblegum") return fallback;
  // 指向不存在用户主题的脏值
  if (stored.startsWith("user-")) {
    return userThemes.some((u) => u.id === stored) ? stored : fallback;
  }
  return BUILTIN_COLOR_THEMES.includes(stored) ? stored : fallback;
}

/** displaySetting 里存过主题(三键任一存在)才返回值;全缺 = 后端尚无记录(触发迁移)。 */
function prefsFromDisplaySetting(
  ds: DisplaySetting | undefined,
  defaults: { mode: ThemeMode; colorTheme: ColorTheme },
): ThemePrefs | null {
  if (!ds) return null;
  if (!("themeMode" in ds) && !("colorTheme" in ds) && !("userThemes" in ds)) return null;
  const userThemes = sanitizeUserThemes(ds.userThemes) ?? [];
  return {
    mode: isThemeMode(ds.themeMode) ? ds.themeMode : defaults.mode,
    colorTheme: resolveColorTheme(ds.colorTheme, userThemes, defaults.colorTheme),
    userThemes,
  };
}

// ─── 旧版 localStorage 读取(仅用于首帧兜底与一次性迁移) ─────────────────
function readLegacyUserThemes(storageKey: string): UserTheme[] {
  const raw = localStorage.getItem(`${storageKey}${USER_THEMES_STORAGE_SUFFIX}`);
  if (raw) {
    try {
      const parsed = sanitizeUserThemes(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // fall through to legacy single-slot migration
    }
  }
  // 更旧的单槽 custom 数据 → 一条名为"自定义"的用户主题(读取时映射,不再回写)
  const legacyLight = localStorage.getItem(`${storageKey}${LEGACY_CUSTOM_LIGHT_SUFFIX}`);
  const legacyDark = localStorage.getItem(`${storageKey}${LEGACY_CUSTOM_DARK_SUFFIX}`);
  if ((legacyLight && legacyLight.trim()) || (legacyDark && legacyDark.trim())) {
    return [
      {
        id: generateUserThemeId(),
        name: i18n.t("common:theme.custom"),
        css: { light: legacyLight ?? "", dark: legacyDark ?? "" },
      },
    ];
  }
  return [];
}

function readLegacyPrefs(
  storageKey: string,
  defaults: { mode: ThemeMode; colorTheme: ColorTheme },
): ThemePrefs | null {
  if (typeof localStorage === "undefined") return null;
  const modeRaw = localStorage.getItem(storageKey);
  const colorRaw = localStorage.getItem(`${storageKey}${COLOR_THEME_STORAGE_SUFFIX}`);
  const userThemes = readLegacyUserThemes(storageKey);
  if (!isThemeMode(modeRaw) && !colorRaw && userThemes.length === 0) return null;
  return {
    mode: isThemeMode(modeRaw) ? modeRaw : defaults.mode,
    colorTheme: resolveColorTheme(colorRaw, userThemes, defaults.colorTheme),
    userThemes,
  };
}

function clearLegacyPrefs(storageKey: string): void {
  for (const key of [
    storageKey,
    `${storageKey}${COLOR_THEME_STORAGE_SUFFIX}`,
    `${storageKey}${USER_THEMES_STORAGE_SUFFIX}`,
    `${storageKey}${LEGACY_CUSTOM_LIGHT_SUFFIX}`,
    `${storageKey}${LEGACY_CUSTOM_DARK_SUFFIX}`,
  ]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* 隐私模式等:清不掉只是下次迁移多跑一次 GET,无害 */
    }
  }
}

/** 乐观更新 store(settings 镜像随之落盘)并 POST 后端;失败静默——本地已生效,
 *  下次改动或权威快照到达后自然校正。返回 POST 是否成功:常规交互路径不关心,
 *  一次性迁移路径(A3)必须确认后端落盘才能清 localStorage 旧键。 */
async function persistDisplayPatch(patch: Partial<DisplaySetting>): Promise<boolean> {
  const store = useSettingsStore.getState();
  const current = store.settings;
  if (current) {
    store.setSettings({ ...current, displaySetting: { ...current.displaySetting, ...patch } });
  }
  try {
    await api.post<{ status: string }>("settings/display", patch);
    return true;
  } catch {
    /* 离线/后端重启窗口:本地状态已生效,放弃本次落盘 */
    return false;
  }
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  defaultColorTheme = "default",
  storageKey = "vite-ui-theme",
  ...props
}: ThemeProviderProps) {
  // 首帧解析顺序:settings 镜像(上次会话的权威值) → 旧版 localStorage → 内置默认。
  const [prefs, setPrefs] = useState<ThemePrefs>(() => {
    const defaults = { mode: defaultTheme, colorTheme: defaultColorTheme };
    return (
      prefsFromDisplaySetting(useSettingsStore.getState().settings?.displaySetting, defaults) ??
      readLegacyPrefs(storageKey, defaults) ?? { ...defaults, userThemes: [] }
    );
  });
  const { mode: theme, colorTheme, userThemes } = prefs;

  // 权威快照(或其他窗口的改动)到达 → 跟随。本组件自己的改动经 persistDisplayPatch
  // 乐观写入 store,回到这里是等值 no-op,不会成环。
  const displaySetting = useSettingsStore((state) => state.settings?.displaySetting);
  useEffect(() => {
    const next = prefsFromDisplaySetting(displaySetting, { mode: defaultTheme, colorTheme: defaultColorTheme });
    if (!next) return;
    setPrefs((prev) =>
      prev.mode === next.mode &&
      prev.colorTheme === next.colorTheme &&
      JSON.stringify(prev.userThemes) === JSON.stringify(next.userThemes)
        ? prev
        : next,
    );
  }, [displaySetting, defaultTheme, defaultColorTheme]);

  // 一次性迁移:旧版数据还躺在本 origin 的 localStorage 里 → 若后端尚无主题记录,
  // 上传旧值;随后清掉旧键(后端已有记录时同样清,权威以后端为准)。
  // 以直接 GET 的服务端值为判断依据,不信 store 初值(可能是陈旧镜像)。
  useEffect(() => {
    const legacy = readLegacyPrefs(storageKey, { mode: defaultTheme, colorTheme: defaultColorTheme });
    if (!legacy) return;
    let cancelled = false;
    void (async () => {
      try {
        const fresh = await api.get<{ displaySetting?: DisplaySetting }>("settings");
        if (cancelled) return;
        // 按键逐个补传:用户可能在迁移完成前已改过某一项(后端只有那一个键),
        // 整体判断会漏传其余旧值(如自定义主题列表)却清掉旧键 → 数据丢失。
        const ds = fresh.displaySetting ?? ({} as DisplaySetting);
        // D14(复查):GET 在途窗口内用户可能已改过某键(persistDisplayPatch 会先乐观写
        // store 镜像)——陈旧 GET 快照看不到它,若仍按旧值补传会把用户刚设的值覆盖回去。
        // 以"后端快照或本地镜像任一已有该键"为准,只补两边都没有的键。
        const mirror = useSettingsStore.getState().settings?.displaySetting ?? ({} as DisplaySetting);
        const has = (key: keyof DisplaySetting) => key in ds || key in mirror;
        const patch: Partial<DisplaySetting> = {};
        if (!has("themeMode")) patch.themeMode = legacy.mode;
        if (!has("colorTheme")) patch.colorTheme = legacy.colorTheme;
        if (!has("userThemes")) patch.userThemes = legacy.userThemes;
        // A3(专题8复查):旧键是补传失败时的唯一重试源——必须等 POST 确认后端已落盘
        // 才能清除。此前 fire-and-forget 即清,GET 成功但 POST 失败的窄窗口会让
        // 自定义主题永久丢失(本地镜像随后被无主题键的权威快照重写)。
        if (Object.keys(patch).length > 0) {
          const persisted = await persistDisplayPatch(patch);
          if (!persisted || cancelled) return; // 旧键保留,下次启动重试迁移
        }
        // 首帧初值已按"镜像 → 旧 localStorage"解析,这里无需再 setPrefs;
        // 后端已有的键以快照跟随效果器为准。
        clearLegacyPrefs(storageKey);
      } catch {
        /* 网络/后端未就绪:旧键保留,下次启动重试迁移 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [storageKey, defaultTheme, defaultColorTheme]);

  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const applyMode = (mode: ThemeMode) => {
      root.classList.remove("light", "dark");
      const resolved = mode === "system" ? (mediaQuery.matches ? "dark" : "light") : mode;
      root.classList.add(resolved);
      // 【预绘制·写侧】把解析后的明暗值持久化,供 root.tsx <head> 内联脚本
      // (读侧,搜同键名)在下次启动首帧前重放,消除暗色用户冷启动白闪。
      try {
        localStorage.setItem("rikkahub.prepaint.theme.v1", resolved);
      } catch {
        /* 配额/隐私模式:缺失仅退化为旧行为(首帧 light) */
      }
    };

    applyMode(theme);

    if (theme !== "system") {
      return;
    }

    const onSystemThemeChange = () => {
      applyMode("system");
    };

    mediaQuery.addEventListener("change", onSystemThemeChange);

    return () => {
      mediaQuery.removeEventListener("change", onSystemThemeChange);
    };
  }, [theme]);

  useEffect(() => {
    if (!isTauriEnvironment() || getSystemInfoSnapshot().platform !== "macos") return;
    // 先订阅上面的媒体查询，再修改 macOS 外观；system 必须清除覆盖，
    // 不能写入解析后的明暗值，否则 WKWebView 的系统主题监听也会被锁定。
    void getCurrentWindow().setTheme(theme === "system" ? null : theme).catch((error) => {
      console.warn("[theme] Failed to sync the macOS window appearance", error);
    });
  }, [theme]);

  useEffect(() => {
    const root = window.document.documentElement;
    root.dataset.theme = colorTheme;
  }, [colorTheme]);

  // 把所有用户主题的 CSS 同时注入到同一个 <style>:每条按自己的 data-theme 作用域隔离,
  // 只有当前 colorTheme 匹配的那条才真正生效,切换主题零延迟、无需重新注入。
  useEffect(() => {
    const blocks = userThemes
      .map((ut) => {
        const light = scopeCssForTheme(ut.css.light, ut.id, "light");
        const dark = scopeCssForTheme(ut.css.dark, ut.id, "dark");
        return [light, dark].filter(Boolean).join("\n\n");
      })
      .filter(Boolean)
      .join("\n\n");

    const existing = document.getElementById(CUSTOM_THEME_STYLE_ID);

    if (!blocks) {
      existing?.remove();
      return;
    }

    const styleElement = existing ?? document.createElement("style");
    styleElement.id = CUSTOM_THEME_STYLE_ID;
    styleElement.textContent = blocks;

    if (!existing) {
      document.head.appendChild(styleElement);
    }
  }, [userThemes]);

  const setTheme = useCallback((next: ThemeMode) => {
    setPrefs((prev) => ({ ...prev, mode: next }));
    void persistDisplayPatch({ themeMode: next });
  }, []);

  const setColorTheme = useCallback((next: ColorTheme) => {
    setPrefs((prev) => ({ ...prev, colorTheme: next }));
    void persistDisplayPatch({ colorTheme: next });
  }, []);

  const addUserTheme = useCallback(
    ({ name, css }: { name: string; css: CustomThemeCss }): UserTheme => {
      const created: UserTheme = {
        id: generateUserThemeId(),
        name: name.trim() || i18n.t("common:theme.unnamed"),
        css,
      };
      const next = [...userThemes, created];
      setPrefs((prev) => ({ ...prev, userThemes: next }));
      void persistDisplayPatch({ userThemes: next });
      return created;
    },
    [userThemes],
  );

  const updateUserTheme = useCallback(
    (id: string, patch: { name?: string; css?: CustomThemeCss }) => {
      const next = userThemes.map((u) =>
        u.id === id
          ? {
              ...u,
              ...patch,
              name: patch.name !== undefined ? patch.name.trim() || u.name : u.name,
            }
          : u,
      );
      setPrefs((prev) => ({ ...prev, userThemes: next }));
      void persistDisplayPatch({ userThemes: next });
    },
    [userThemes],
  );

  const deleteUserTheme = useCallback(
    (id: string) => {
      const next = userThemes.filter((u) => u.id !== id);
      const patch: Partial<DisplaySetting> = { userThemes: next };
      // 删的恰好是当前主题 → 回退到默认,避免界面卡在一个已无 CSS 的作用域上
      const nextColor = colorTheme === id ? "default" : colorTheme;
      if (nextColor !== colorTheme) patch.colorTheme = nextColor;
      setPrefs((prev) => ({ ...prev, userThemes: next, colorTheme: nextColor }));
      void persistDisplayPatch(patch);
    },
    [userThemes, colorTheme],
  );

  // value 用 useMemo 聚合稳定的 handler,避免 ThemeProvider 内部 state 变化时
  // 重建 value 对象、导致所有 useTheme() 消费者无差别重渲染。
  const value = useMemo<ThemeProviderState>(
    () => ({
      theme,
      setTheme,
      colorTheme,
      setColorTheme,
      userThemes,
      addUserTheme,
      updateUserTheme,
      deleteUserTheme,
    }),
    [
      theme,
      setTheme,
      colorTheme,
      setColorTheme,
      userThemes,
      addUserTheme,
      updateUserTheme,
      deleteUserTheme,
    ],
  );

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};
