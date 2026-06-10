import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  // Gruve contract §3: friends load the app at /peer/<node>/apps/pharaoh/ —
  // the build must work under a sub-path, so all asset URLs must be relative.
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
