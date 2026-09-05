// foundation/errors.ts — 业务错误码通道。
//
// 背景(内测反馈 /compact 文案 i18n):后端抛错文案是硬编码中文,HTTP 层原样透传,
// 前端 toast 直接展示——英文界面用户看到中文错误。后端没有请求语言上下文(也不该有,
// 文案是表现层职责),正路是错误码:后端抛 CodedError(码+中文兜底文案),HTTP 响应带
// errorCode 字段,前端按码查 i18n 文案、查不到用后端 message 兜底。旧端点/未编码错误
// 不带 errorCode,前端行为不变——通道向后兼容,未来任何业务错误按需接入。
export class CodedError extends Error {
  constructor(
    message: string,
    readonly errorCode: string,
  ) {
    super(message);
    this.name = "CodedError";
  }
}
