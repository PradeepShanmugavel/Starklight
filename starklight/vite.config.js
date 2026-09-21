import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Starklight talks to the existing Express proxy (server.js) unchanged — it stays exactly
// where it is (default http://localhost:3000). The dev proxy below just makes /api/* calls
// look same-origin during `npm run dev` so the browser never blocks them on CORS. In
// production, point VITE_API_BASE at wherever server.js is actually deployed.
//
// CONFIRMED live on Windows: proxying to bare "localhost" intermittently
// 502'd even though the backend answered every direct curl instantly —
// Node's proxy resolved "localhost" to ::1 in a way that didn't reliably
// reach a server also listening on 0.0.0.0. Pinning to the literal IPv4
// loopback address sidesteps that resolution entirely.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_API_BASE || 'http://127.0.0.1:3000',
        changeOrigin: true
      }
    }
  }
})
