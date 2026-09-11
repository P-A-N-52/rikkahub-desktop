# macOS development and local builds

The macOS port shares the existing Tauri shell, Bun backend, React UI and data formats. Apple Silicon is the first validation target. Intel has a separate build target; native Intel and macOS 13 runtime validation are tracked separately from build success.

## Prerequisites

- macOS with Xcode Command Line Tools and the macOS SDK.
- Bun **1.4.0**, Rust/Cargo and the `aarch64-apple-darwin` target.
- The repository's existing frontend/backend lockfiles and the Pi vendor baseline below.

From a fresh repository, restore Pi once:

```bash
git clone --filter=blob:none --no-checkout https://github.com/earendil-works/pi.git pi
git -C pi checkout 5cd93f688aaab89dbb6dfa4aca535f21796ae185
(cd pi && git apply ../pi-patches/*.patch && bun install)
(cd pi/packages/ai && bun run generate-models)
(cd pc-server && bun install --frozen-lockfile)
(cd web-ui && bun install --frozen-lockfile)
rustup target add aarch64-apple-darwin
```

Pi is a required source dependency. Do not repeat patch application in an already initialized checkout or delete `pi/` as an optional reference directory. Model manifest generation downloads public model metadata; it does not require provider credentials.

## Desktop development

From `web-ui/`:

```bash
bun run tauri:dev:macos
# Optional explicit ports:
bun run tauri:dev:macos --backend-port 18080 --frontend-port 15173
```

One launcher owns the source backend, Vite and Tauri. It waits for backend bootstrap to report readiness, then opens the WebView at Vite. This source development mode does not require a compiled sidecar or packaged frontend resources. Backend source changes restart Bun through `--watch`; UI changes use Vite hot updates. The proxy forwards interrupted stream errors so clients can use their existing reconnect logic. Ctrl+C or a failed child shuts down the launcher's own process groups.

Default ports are 8080 for the backend and 5173 for Vite. They are strict in this mode: a collision reports an error without terminating another application or silently changing the proxy target. Production retains the existing backend port selection and handshake.

Development data defaults to `dist/macos-dev/pc-data` under the repository. Set `RIKKAHUB_PC_DATA_DIR` to explicitly use another development directory. The launcher disables analytics for development and passes its backend URL to Vite's HTTP/SSE/WebSocket proxy. A release build ignores the development WebView override and starts its bundled backend.

## Build an application and DMG

From `web-ui/`:

```bash
bun run tauri:build:macos --target aarch64-apple-darwin
# Application only:
bun run tauri:build:macos --target aarch64-apple-darwin --bundles app
# Separate Intel build (requires its Rust target):
bun run tauri:build:macos --target x86_64-apple-darwin
```

The entry compiles the real sidecar, builds frontend resources through Tauri's existing build hook, signs the nested Bun executable and application separately, then creates the DMG from that application. `--target` is required. Target and asset naming live in `pc-server/shared/desktop-targets.ts`; CI invokes the same build entry.

Outputs:

- Application: Cargo's target directory, `<target>/release/bundle/macos/Rikkahub.app`.
- Application ZIP: `dist/desktop/<target>/Rikkahub_<version>_mac_arm64.app.zip`.
- DMG: `dist/desktop/<target>/Rikkahub_<version>_mac_arm64.dmg`.

The ZIP is created with `ditto` to preserve application directory structure and executable permissions. When using `CARGO_TARGET_DIR`, the script obtains the actual location through Cargo metadata.

The Intel target is `x86_64-apple-darwin`, with `mac_x64` asset names. A successful cross-build does not establish native Intel support. The configured deployment target is macOS 13.0; inspect both Mach-O binaries and validate the complete application on that OS before claiming minimum-version support.

The default uses ad-hoc signing with hardened runtime and verifies the resource seal. This verifies local integrity, not Developer ID identity, notarization or Gatekeeper acceptance of an Internet download. `--no-sign` explicitly skips signing and can leave only the linker's incomplete signature. Ordinary PR checks use no signing secrets. See [macOS release validation](macos-release.md) for release-source configuration, manifests, Developer ID signing and notarization.

## Data, resources and diagnostics

For the default `com.rikkahub.pc` application identifier:

| Item | Location |
| --- | --- |
| Default application data | `~/Library/Application Support/com.rikkahub.pc/pc-data` |
| Shell configuration | `~/Library/Application Support/com.rikkahub.pc/user-config.json` |
| Shell startup log | `~/Library/Logs/com.rikkahub.pc/shell.log` |
| Backend diagnostic files | `<selected data directory>/logs/` |
| Read-only bundled resources | `Rikkahub.app/Contents/Resources/{web-ui/build/client,fonts,icons}` |

The data selection order is `RIKKAHUB_PC_DATA_DIR`, then the existing `user-config.json` `data_dir`, then the platform default. Explicit paths must be absolute. The first default directory or an explicit new environment-selected directory can be created; a saved directory that has disappeared must be restored or corrected rather than silently recreated empty. Invalid configuration is reported while the original file is preserved.

The shell's `set_data_dir` command saves the directory used by a later launch; it does not copy data. There is currently no application UI for changing/migrating the data directory. To reuse an older development directory, explicitly select the existing directory in configuration or use the existing backup export/import UI. Do not move a live database or automatically search the disk for old data.

The packaged shell passes `RIKKAHUB_RESOURCE_DIR` to the backend. This explicit root has a fixed layout; missing required resources are errors, and the backend will not hide a broken package by finding files in a developer checkout. Custom fonts, conversation data and caches stay under the selected data directory.

The shell begins on an empty page and navigates once the backend reports its actual port. Production keeps the existing `http://localhost:<port>` origin so existing origin-scoped preferences remain available. The shell log records startup, selected paths, the port and startup errors; backend operational diagnostics remain in its own data directory.

## Windows, menus and shutdown

macOS uses native window controls and App/Edit/Window menus. Cmd+W or the red close button hides the window by default, keeping background work active; reopening the application restores the same window. The existing window/tray preference can instead make closing quit the application. Cmd+Q and the explicit Quit menu always request shutdown. Settings is available through the application menu and its configurable keyboard shortcut, Cmd+, by default.

The shell waits for its owned backend to finish shutdown before exiting. Requests, generation continuations, finite streams and owned child processes share a bounded shutdown path, followed by JSON/SQLite persistence. A failed or timed-out flush is reported as unsuccessful and leaves diagnostic evidence for the next launch. An unexpectedly stopped backend produces a native error sheet. SIGKILL cannot run a process's cleanup code and does not guarantee preservation of uncommitted changes.

The macOS parent-watchdog uses the `RIKKAHUB_PARENT_PID` protocol proposed in [upstream PR #39](https://github.com/yuh-G/rikkahub-desktop/pull/39). It validates the actual parent relationship and is enabled only for explicitly launched macOS sidecars. Ordinary standalone backend runs do not enable it.

Folders protected by macOS privacy controls, such as Desktop or Documents, can require system consent. The default Application Support data directory avoids needing broad folder access for ordinary startup. Check outstanding system prompts when a deliberately selected protected directory stalls filesystem initialization; do not assume a bound HTTP port proves bootstrap completion.

## Keyboard and system features

New installations and explicitly reset shortcuts use Cmd+N for a new conversation, Cmd+Shift+F for search, Cmd+, for settings, Cmd+I for image generation, and Cmd+Option+Up/Down for conversation navigation. Existing bindings, empty bindings and disabled actions remain unchanged, including saved Ctrl shortcuts. Cmd+Enter sends a message under either Enter preference; composition events are ignored until the input method commits text. Cmd+vertical wheel changes interface size; trackpad pinch events reported as Ctrl+wheel do not change that setting.

Clipboard tools use the native `pbcopy` and `pbpaste` commands with UTF-8 text, preserving whitespace and empty values. System speech uses `say` to generate PCM WAV audio for the existing player and export endpoint. Cancellation and application shutdown reclaim owned synthesis and clipboard processes. Speech recognition uses the provider selected in settings; enabling it requires microphone consent, and the application bundle includes its microphone purpose description. Stopping capture or changing conversation releases the capture session.

The packaged app queries installed font families through CoreText. Built-in and custom fonts load independently of the system query; a failed system query is visible and can be retried. Standalone source backend runs without the shell helper use macOS's asynchronous font report instead. No system font files are copied into the application.

Automatic proxy mode reads the effective top-level HTTP/HTTPS settings from `scutil --proxy`, using the existing asynchronous cache. PAC and automatic discovery are detected for diagnostics; this implementation does not execute PAC scripts or reinterpret SOCKS endpoints as HTTP proxies. Direct, manual and environment modes retain their existing behavior. Proxy credentials are omitted from diagnostic URLs.

Finder-launched commands preserve the inherited PATH and append the existing `/opt/homebrew/bin` and `/usr/local/bin` directories when absent. Startup does not execute shell profile files. Use absolute executable paths for commands installed elsewhere; workspace commands retain their normal trust and permission checks.

## Verification

```bash
(cd pc-server && bun run typecheck && bun test)
(cd web-ui && bun run typecheck && bun run test:unit)
(cd web-ui/src-tauri && cargo check --locked --target aarch64-apple-darwin)
(cd web-ui/src-tauri && cargo test --lib --locked --target aarch64-apple-darwin)
```

Use isolated backend test data. The existing smoke scripts rebuild their named `pc-data/smoke-*` fixtures; preserve any prior fixtures before running them. Local mock tests do not verify paid or real providers. The backend typecheck filters Pi internal diagnostics and reports the filter count separately.

Before accepting a package, copy it outside the repository and launch it through Finder. Check the actual WebView, API/SSE, static assets, fonts and icons; verify both selected and default data locations and failure diagnostics. Compilation and a plain HTTP 200 are insufficient to establish a working application.

To regenerate the macOS icon from the existing vector brand mark:

```bash
(cd pc-server && bun run scripts/build-macos-icon.ts)
```

The source mark remains `icons/rikkahub.svg`; the generated ICNS includes 1024px artwork. The macOS configuration also retains an existing PNG for Tauri's runtime window icon.
