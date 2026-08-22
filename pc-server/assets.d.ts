// assets.d.ts — 嵌入资源的模块声明(bun-types 的 extensions.d.ts 未覆盖 tar.gz)。
// `with { type: "file" }` 让 `bun build --compile` 把文件嵌进 exe,运行时 import 得到
// 一个可经 Bun.file() 读取的路径字符串(dev 下是真实相对路径,编译后是 /$bunfs/ 虚拟路径)。

declare module "*.tar.gz" {
  /** Bun `--compile` 嵌入资源的路径句柄;经 Bun.file(path) 读字节。 */
  const path: string;
  export default path;
}
