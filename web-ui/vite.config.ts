import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import svgr from "vite-plugin-svgr";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter(), tsconfigPaths(), svgr()],
  server: {
    strictPort: true,
    watch: { ignored: ["**/src-tauri/target/**", "**/src-tauri/gen/**"] },
    proxy: {
      "/api": {
        target: process.env.RIKKAHUB_DEV_BACKEND_URL || "http://127.0.0.1:8080",
        changeOrigin: true,
        ws: true,
        configure(proxy) {
          // Backend restarts must close active streams so the client can reconnect.
          proxy.on("proxyRes", (response, _request, clientResponse) => {
            response.once("error", () => clientResponse.destroy());
          });
        },
      },
    },
  },
});
