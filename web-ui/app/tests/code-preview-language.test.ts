import { describe, expect, test } from "bun:test";

import { getCodePreviewLanguage } from "~/components/workbench/code-preview-language";

describe("getCodePreviewLanguage", () => {
  test("html/htm → html;svg/md/mermaid 各归其类", () => {
    expect(getCodePreviewLanguage("html")).toBe("html");
    expect(getCodePreviewLanguage("HTM")).toBe("html");
    expect(getCodePreviewLanguage("svg")).toBe("svg");
    expect(getCodePreviewLanguage("md")).toBe("markdown");
    expect(getCodePreviewLanguage("mmd")).toBe("mermaid");
  });
  test("xml 不可预览:塞进 html iframe 只会渲染乱码,完成后自动切预览会直接怼给用户", () => {
    expect(getCodePreviewLanguage("xml")).toBeNull();
  });
  test("未知语言与空串不可预览", () => {
    expect(getCodePreviewLanguage("python")).toBeNull();
    expect(getCodePreviewLanguage("")).toBeNull();
  });
});
