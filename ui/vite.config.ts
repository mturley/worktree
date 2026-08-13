import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  build: { emptyOutDir: false }, // preserve ui/dist/.gitkeep
  server: {
    port: 5175,
    proxy: { "/api": { target: "http://localhost:8475", changeOrigin: true, ws: false } },
  },
})
