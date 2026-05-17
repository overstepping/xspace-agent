import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Builds the public ask page into the server's public/ directory so the
// existing Express static handler serves it at /ask/.
export default defineConfig({
  base: '/ask/',
  build: {
    outDir: resolve(here, '../server/public/ask'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      // Proxy API + Socket.IO to the running xspace-agent dev server.
      '/api':      { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io':{ target: 'http://localhost:3000', changeOrigin: true, ws: true },
    },
  },
})
