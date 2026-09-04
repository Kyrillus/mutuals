import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// There is no CORS anywhere in this project, by design (ADR-011): in development Vite proxies /api
// to Fastify, and in production Fastify serves the built SPA and /api/v1/* from one origin.
export default defineConfig({
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  envDir: '../..',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 3000,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: true } },
  },

  // `vite preview` serves the built SPA the e2e suite drives (ADR-082), and it needs the same single
  // origin the other two modes have. Without a proxy here every /api call from the previewed build
  // 404s against the static server, and ADR-011 rules out CORS as the way round it.
  //
  // Both ports come from the environment so an e2e run can sit beside a `pnpm dev` on 3000/3001
  // rather than race it: silently reusing the dev server would point the suite at mutuals_dev.
  preview: {
    port: Number(process.env.PREVIEW_PORT ?? 4173),
    strictPort: true,
    // Explicit, because `localhost` resolves to ::1 here and Playwright polls 127.0.0.1: the server
    // comes up, the readiness check never sees it, and the run dies as "Timed out waiting 60000ms".
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.API_PORT ?? '3001'}`,
        changeOrigin: true,
      },
    },
  },
})
