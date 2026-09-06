import i18n from "i18next";

/** 通用错误码 → i18n 键前缀。后端 foundation/errors 的 CodedError 与前端本地合成的
 *  错误码(network_unreachable 等)共用同一通道:有码且字典有键时人话优先,无键回退
 *  error.message——各调用点不再各自判断 instanceof ApiError(压缩错误的既有先例)。 */
const ERROR_CODE_KEY_PREFIX = "errors.";

/** 提取错误的人话文案:优先 errorCode 的 i18n 翻译,其次 error.message,最后兜底。 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "errorCode" in error) {
    const errorCode = (error as { errorCode?: unknown }).errorCode;
    if (typeof errorCode === "string" && errorCode) {
      const key = `${ERROR_CODE_KEY_PREFIX}${errorCode}`;
      if (i18n.exists(key)) return i18n.t(key);
    }
  }
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}
