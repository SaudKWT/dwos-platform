import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  server: {
    port: 4200,
    // The API runs on 5280. Proxying keeps the browser same-origin in dev, so
    // the client uses plain relative URLs and needs no CORS or base-URL config
    // — the same paths work in production, where the API serves the built app.
    proxy: { '/api': { target: 'http://127.0.0.1:5280', changeOrigin: true } },
  },
})
