# macOS icon

`icon.icns` is generated from the existing `icons/rikkahub.svg` brand mark, with the white circular background used by the desktop icon. The SVG stays the single source of the mark; the existing Windows icons are unchanged.

From the repository root, run:

```sh
bun run pc-server/scripts/build-macos-icon.ts
```

The installed Tauri CLI generates the icon sizes in `dist/desktop/icon/`. Only the resulting `icon.icns` is copied here. The `.icns` includes 1024px artwork rendered from the vector source.
