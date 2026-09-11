import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repositoryDir = resolve(import.meta.dir, "../..");
const outputDir = join(repositoryDir, "dist/desktop/icon");
mkdirSync(outputDir, { recursive: true });

// 沿用桌面图标的白圆底和黑色标志，从现有 SVG 生成各分辨率，不放大 192px PNG。
const mark = readFileSync(join(repositoryDir, "icons/rikkahub.svg"), "utf8")
  .replace("<svg ", '<svg x="140" y="140" color="#000" ')
  .replace(/\bwidth="[^"]*"/, 'width="744"')
  .replace(/\bheight="[^"]*"/, 'height="744"');
const source = join(outputDir, "icon-macos.svg");
writeFileSync(source, `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><circle cx="512" cy="512" r="476" fill="#fff"/>${mark}</svg>\n`);

const child = Bun.spawnSync([process.execPath, "run", "tauri", "icon", source, "--output", outputDir], {
  cwd: join(repositoryDir, "web-ui"), stdout: "inherit", stderr: "inherit",
});
if (child.exitCode !== 0) throw new Error(`Tauri icon generation failed with exit code ${child.exitCode}`);
const icon = join(repositoryDir, "web-ui/src-tauri/icons/icon.icns");
copyFileSync(join(outputDir, "icon.icns"), icon);
console.log(`macOS icon: ${icon}`);
