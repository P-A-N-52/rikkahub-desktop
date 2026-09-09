# CLAUDE.md

Guidance for Claude Code when working on this repository.

## What this project is

RikkaHub PC — a Windows desktop LLM chat client. Bun-runtime single-file backend (`pc-server/server.ts`) hosts an embedded React SPA (`web-ui/`) at `http://localhost:8080`. The whole thing compiles into one portable Windows exe via `bun build --compile`.

## Layout

```
pc-server/              # Bun backend
  server.ts             # The whole backend in one file (~10k lines): routes, SSE,
                        # provider clients (OpenAI / Claude / Google), tool dispatch,
                        # MCP, search services, TTS/ASR, WebDAV/S3 backup
  scripts/              # Smoke tests
  package.json          # bun run dev / start / compile / smoke:request-chain

web-ui/                 # React Router 7 SPA (SPA mode, no SSR)
  app/
    routes/             # File-routed pages (home/conversations, settings, images)
    components/         # message, input, ui (shadcn), markdown, extended
    stores/             # Zustand slices
    types/              # TypeScript types kept in sync with backend
  public/               # Static assets
  copy.ts               # Post-build: mirrors build/client into ../dist/web-ui/build/client
                        # so the portable exe can serve it

pi/                     # Vendored pi coding agent (workspace-mode engine). Independent
                        # shallow git clone, EXCLUDED from this repo (.gitignore) — its
                        # version control lives in pi/.git. Carries local patch commits;
                        # see "pi vendor 维护手册" below.
pi-patches/             # git format-patch exports of our local pi commits (tracked here
                        # so patches survive re-clones; restore with `git am`)

icons/                  # Provider/search-service SVG/PNG logos
dist/                   # Portable bundle: rikkahub-pc.exe + icons + web-ui build
                        # Also where pc-data/ lives at runtime when running the exe
pc-data/                # Runtime state (gitignored). Contains API keys — never commit.
```

## Development commands

```bash
# Backend dev (watches state file, serves API on 8080)
cd pc-server && bun run server.ts

# Frontend dev (Vite on 5173, proxies /api to 8080)
cd web-ui && bun install && bun run dev

# Type check the SPA
cd web-ui && bun run typecheck

# Production build → produces a fresh portable exe
cd web-ui && bun run build          # build SPA + copy to dist/
cd pc-server && bun run compile     # bundles server.ts → ../dist/rikkahub-pc.exe

# Backend smoke (spins up mock provider/MCP/WebDAV and exercises the request chain)
cd pc-server && bun run smoke:request-chain
```

## Architecture notes

### Backend (`pc-server/server.ts`)

Single file by design — easier to compile, ship, and audit. Major sections in order:

- **Type definitions** (Model, Provider, Assistant, Conversation, Settings, etc.)
- **Persistence** — `loadState()` / `saveState()` over `pc-data/state.json`. Normalize on load
  backfills new defaults (search services, abilities, schema upgrades).
- **Throttled IO** — `scheduleThrottledSaveState()` (~5/s during streaming) and
  `scheduleNodeBroadcast()` (~30 fps SSE coalescing) keep streaming smooth.
- **SSE infra** — `conversationClients`, `broadcastNodeUpdate`, `openSse`.
- **Provider clients**:
  - OpenAI Chat Completions / Responses API streaming (`fetchOpenAiTextStreaming`)
  - Anthropic Claude streaming with tool use, thinking deltas, input_json_delta
    (`streamClaudeChatWithTools` + `readClaudeStreamingRound`)
  - Google Gemini generateContent
- **Tool dispatch** — `executeToolCall` runs local tools (memory, time, files), MCP tools,
  search tools, and skill tools. Tool parts created live during streaming.
- **Search services** — 17 implementations in `runSearchService` and `testSearchService`.
- **Backup** — WebDAV (XML), S3-compatible (AWS SigV4 with custom endpoint support).
- **Route table** — every `path === "..."` block at the bottom.

### Frontend (`web-ui/app/`)

- Settings SSE: `useSettingsSubscription` opens `/api/settings/stream` once at root.
- Conversation SSE: `useConversationDetail` opens `/api/conversations/:id/stream`,
  applies `node_update` events via `applyNodeUpdate`.
- Pickers: model / reasoning / search / files in `components/input/`. The search picker
  filters by `service.testPassed` (preset services bypass the gate).
- Messages render via `MessageParts` → `MessagePart` dispatcher; thinking shown via
  `ChainOfThought`, tools via `ToolStepPart`.

### Type sync between frontend and backend

Both sides define their own types (TypeScript vs ad-hoc types in `server.ts`). When changing
a shared shape (parts, settings, dtos), update both. The build won't catch a mismatch — only
the runtime will.

## Key conventions

- **Don't write comments that just restate the code.** Backend comments should explain
  non-obvious invariants (throttle coalescing, provider quirks, tool replay).
- **No "原版 / Android / PC 版" wording in user-facing strings.** This is a standalone product.
- **Default System Prompt** lives in `defaultSettings.assistants[1].systemPrompt` in
  `server.ts`. Keep its template variables (`{{char}}`, `{{model_name}}`, `{{cur_datetime}}`,
  `{{locale}}`, `{{timezone}}`, `{{user}}`) — they're resolved by the input transformer pipeline.
- **Never write user API keys** anywhere in version control. `pc-data/` is gitignored;
  the smoke tests use mock providers.
- **No bare `catch {}` without intent** (P2-1 discipline): every catch must either call
  `reportError(domain, severity, message, cause)` from `observability/app-errors.ts`, or
  carry a comment explaining why swallowing is safe (parse fallback / best-effort cleanup).
  Severity guide: `error` = user must know (global toast), `warn` = perceivable degradation,
  `info` = error-center record only.
- **All outbound LLM fetch goes through one interceptor** (`installProxyFetchInterceptor` in
  `foundation/net.ts`, installed over `globalThis.fetch`). It does two things per-request:
  (1) injects the `proxy` option from the current proxy config, and (2) injects `timeout: 0`
  to disable Bun's 300s socket idle timer — which would otherwise kill thinking-model
  requests that stay silent >300s awaiting response headers. Timing authority lives solely
  in our app-layer watchdogs (`headerTimeoutMs` 600s / `STREAM_IDLE_TIMEOUT_MS` 120s /
  `AbortSignal.timeout`). **New inference/agent engines must call plain `fetch` with their own
  AbortSignal + watchdog and never pass a numeric Bun `timeout` themselves** — the interceptor
  already disabled the idle kill, and a caller-supplied numeric timeout would fight the
  watchdog for the clock. Callers that pass an explicit `init.timeout` are respected (guard),
  and `Request`-object inputs (Bun.serve inbound forwards) are skipped. Locked by
  `scripts/proxy-behavior-smoke.ts` §D. Runtime pins Bun 1.4.0 (ci / build-linux / Dockerfile / @types/bun).
- **输出上限（`max_tokens` 家族）只有一个来源**：`model-providers/model-limits.ts`。两条纪律：
  ①**协议允许省略时就不发这个字段** —— OpenAI completions/responses 与 Google 的上限是可选的，
  用户没在助手里配就整个字段不出现（不发＝用服务端默认＝恒合法；发一个猜来的数就是 400 的
  来源，安卓同语义）。②**协议必填时**（Anthropic 的 `max_tokens`、pi 的 `ProviderConfigInput`）
  数值走 `requiredOutputCap`：用户配置 > 方言登记表 > models.dev 真值（按端点 host 身份查、
  丢弃 `output >= context` 的占位行、同 host 多条取 min）> `DEFAULT_OUTPUT_TOKENS`。
  我们自己定的内部预算（OCR、提示词优化、连通性测试）走 `internalOutputCap` 收进模型真实上限。
  **新模型上限未知时**：`requiredOutputCap` 会发一条 `output_limit_unknown` 的 info 级
  `reportError`（错误中心可见）——看到它就去查厂商官方 API 文档的模型页，把
  「最大输出 Tokens」按模型级正则登记进 `request-dialect.ts` 的 `OUTPUT_LIMIT_FACTS`
  （注释写清出处与核实日期；只认厂商自己的文档，聚合站不算实证；厂商未单独公布输出上限的
  就别编数，让它落兜底）。两道防线锁在 `model-providers/model-limits.test.ts`。

## Common tasks

- **Adding a search service**: implement in `runSearchService` and `testSearchService`,
  add the default-services entry, add the type to the dropdown in `routes/settings.tsx`,
  and add the label to `SEARCH_SERVICE_TYPE_LABELS` (settings) and `SEARCH_SERVICE_LABELS`
  (picker).
- **Adding a provider**: extend the `providers/providers` switch in `callProvider` and
  `callProviderStreaming`, add to the defaultSettings list, add provider-specific paths
  for the test endpoints.
- **Releasing a new exe**: web-ui build + pc-server compile. Smoke first.
- **Releasing the Linux binary**: push a `v*.*.*` tag — `.github/workflows/build-linux.yml`
  builds web-ui + compiles the x64 binary + packs both into a tar.gz, and attaches it to the
  Release automatically. The tar.gz is **not** a bare binary: `routeStatic` serves the
  frontend from `web-ui/build/client/` next to the exe at runtime, so the bundle must ship
  both or the user sees "web-ui is not built". The in-app updater matches the asset by the
  `Rikkahub_<tag>_linux_x64.tar.gz` naming convention, so don't rename the uploaded file.
  Windows (`Rikkahub_<tag>_x64-setup.exe`) and Linux assets live side by side on the same
  Release.

## pi vendor 维护手册（工作区引擎上游）

`pi/` 是工作区模式引擎的 vendored 源码：独立浅克隆 git 仓库，宿主 `.gitignore` 排除，
版本管理在 `pi/.git` 内。**pc-server 直接 import 其 TS 源码**（见 `pi-engine/`），因此
它的状态直接影响构建与行为。

**当前基线**：上游 `5cd93f688`（2026-08-20）+ 本地补丁提交 `fe2d0c560`
（`[RIKKAHUB PATCH: budget-xhigh-max]`，5 文件 14 处：ThinkingBudgets 扩 xhigh/max 键，
详见提交信息）。本地提交同步导出于 `pi-patches/`（宿主仓库跟踪，可分发）。

**补丁纪律**（typecheck.ts 头注同款）：
- 仅允许功能补丁，且必须同时具备三件套：行内 `[RIKKAHUB PATCH: <名>]` 标记、
  pi 仓库独立 commit + `pi-patches/` 导出、宿主侧行为锁定测试（补丁丢失即测试变红，
  现有样例：`pc-server/pi-engine/model-bridge.test.ts` 的 "vendor 补丁行为锁定"）。
- 禁止为压 tsc 噪音改 pi 源码（消音性改动）。
- 动 pi 文件后必须裸跑 `cd pc-server && bunx tsc --noEmit` 核对补丁文件零新增诊断
  （`bun run typecheck` 会滤除 pi 内部诊断，补丁自身的类型错误会被吞掉）。

**上游更新流程**（每次升级 pi 必须走完）：
1. `pi/` 内 fetch 上游新版 → rebase 本地补丁提交（冲突点即补丁点，逐个调和）。
2. `grep -rn "RIKKAHUB PATCH" pi/packages` 核对全部标记存活；重新 `git format-patch`
   刷新 `pi-patches/`。
3. **清除冗余（必做）**：逐个补丁自问"上游是否已原生支持？"——若已支持（如
   ThinkingBudgets 原生含 xhigh/max），删除对应补丁改用上游实现；同时重审
   `pc-server/pi-engine/model-bridge.ts` 的全部 compat 覆盖与 thinkingLevelMap 登记
   （supportsStore / supportsDeveloperRole / forceAdaptiveThinking / xhigh/max 放行等），
   上游默认行为已对齐的覆盖一并删除，不留冗余层。
4. 宿主验证：裸跑 tsc 核对补丁文件（见补丁纪律）→ `bun test pc-server web-ui` 全量
   （跨引擎平价测试 + 补丁行为锁定测试兜底）。
5. pi 的 pre-commit 在浅克隆环境有既有噪音（bedrock/smithy 类型错，与补丁无关）：
   若报错均位于未触碰文件，`--no-verify` 提交并在提交信息注明缘由。

**重建环境**（换机器 / 重新 clone 宿主仓库后 `pi/` 不存在）：
浅克隆 pi 上游到基线提交，然后 `git am pi-patches/*.patch` 重放本地补丁，
跑一遍上面第 4 步验证。
