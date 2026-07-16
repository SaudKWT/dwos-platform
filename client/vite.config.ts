import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    // 5173 by default; PORT lets a second checkout run alongside the first.
    port: Number(process.env.PORT) || 5173,
    // The API runs on 5280. Proxying keeps the browser same-origin in dev, so
    // the client uses plain relative URLs and needs no CORS or base-URL config
    // — the same paths work when the API serves the built app in production.
    proxy: {
      '/api':  { target: 'http://127.0.0.1:5280', changeOrigin: true },
      '/hubs': { target: 'http://127.0.0.1:5280', changeOrigin: true, ws: true },
    },
  },
  build: { outDir: 'dist' },
})
