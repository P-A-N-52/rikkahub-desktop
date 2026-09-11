// Bun、Cargo、Tauri sidecar 与分发名称共用这一目标表。
export const desktopTargets = {
  "x86_64-pc-windows-msvc": {
    platform: "windows", bunTarget: "bun-windows-x64", extension: ".exe", bundleArch: "x64", assetArch: "x64",
  },
  "aarch64-apple-darwin": {
    platform: "mac", bunTarget: "bun-darwin-arm64", extension: "", bundleArch: "aarch64", assetArch: "arm64",
  },
  "x86_64-apple-darwin": {
    platform: "mac", bunTarget: "bun-darwin-x64", extension: "", bundleArch: "x64", assetArch: "x64",
  },
} as const;

export type DesktopTarget = keyof typeof desktopTargets;

export function desktopOutputNames(target: DesktopTarget, productName: string, version: string) {
  const platform = desktopTargets[target];
  const assetBase = `${productName}_${version}_${platform.platform}_${platform.assetArch}`;
  return {
    binary: `rikkahub-pc${platform.extension}`,
    sidecar: `rikkahub-server-${target}${platform.extension}`,
    app: `${productName}.app`,
    appArchive: `${assetBase}.app.zip`,
    dmg: `${assetBase}.dmg`,
    tauriDmg: `${productName}_${version}_${platform.bundleArch}.dmg`,
  };
}
