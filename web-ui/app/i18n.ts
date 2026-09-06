import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { readSettingsMirror } from "./lib/settings-mirror";

import enUSCommon from "./locales/en-US/common.json";
import enUSInput from "./locales/en-US/input.json";
import enUSMarkdown from "./locales/en-US/markdown.json";
import enUSMessage from "./locales/en-US/message.json";
import enUSPage from "./locales/en-US/page.json";
import enUSSettings from "./locales/en-US/settings.json";
import zhCNCommon from "./locales/zh-CN/common.json";
import zhCNInput from "./locales/zh-CN/input.json";
import zhCNMarkdown from "./locales/zh-CN/markdown.json";
import zhCNMessage from "./locales/zh-CN/message.json";
import zhCNPage from "./locales/zh-CN/page.json";
import zhCNSettings from "./locales/zh-CN/settings.json";

const SUPPORTED_LANGUAGES = ["zh-CN", "en-US"] as const;

function getInitialLanguage(): (typeof SUPPORTED_LANGUAGES)[number] {
  if (typeof window === "undefined") {
    return "zh-CN";
  }

  // 专题8:语言的权威存储在后端 displaySetting.language(root.tsx 负责快照跟随与
  // 用户切换时的上报)。首帧从 settings 镜像同步取上次会话的权威值,避免语言闪动。
  const fromMirror = readSettingsMirror()?.displaySetting?.language;
  if (fromMirror === "zh-CN" || fromMirror === "en-US") {
    return fromMirror;
  }

  // 旧版把语言直接存 localStorage("lang",按 origin 隔离,改端口即丢)。留作迁移
  // 兜底:root.tsx 在后端尚无记录时会把当前生效语言上报,此后镜像分支接管。
  const fromStorage = window.localStorage.getItem("lang");
  if (fromStorage === "zh-CN" || fromStorage === "en-US") {
    return fromStorage;
  }

  const browserLanguage = window.navigator.language;
  return browserLanguage.startsWith("zh") ? "zh-CN" : "en-US";
}

void i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": {
      common: zhCNCommon,
      input: zhCNInput,
      markdown: zhCNMarkdown,
      message: zhCNMessage,
      page: zhCNPage,
      settings: zhCNSettings,
    },
    "en-US": {
      common: enUSCommon,
      input: enUSInput,
      markdown: enUSMarkdown,
      message: enUSMessage,
      page: enUSPage,
      settings: enUSSettings,
    },
  },
  lng: getInitialLanguage(),
  fallbackLng: "zh-CN",
  supportedLngs: [...SUPPORTED_LANGUAGES],
  defaultNS: "common",
  ns: ["common", "input", "markdown", "message", "page", "settings"],
  interpolation: {
    escapeValue: false,
  },
  // 裸键名渲染事故的防回潮网:缺键在生产静默回退 key 本身(用户可见但不断流),
  // dev 环境必须 console.error 暴露出来,让"键拼错/漏翻译"在开发期就红。
  ...(import.meta.env.DEV
    ? {
        parseMissingKeyHandler: (key: string, defaultValue?: string) => {
          console.error(`[i18n] missing key: ${key}`, defaultValue ?? "");
        },
      }
    : {}),
});

export default i18n;
