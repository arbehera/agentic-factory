import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Agent Operations Portal web app. In dev, /api is proxied to the portal API (apps/portal-api).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": process.env.PORTAL_API_URL ?? "http://localhost:3002" } },
});
