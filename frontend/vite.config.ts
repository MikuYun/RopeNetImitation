import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// 后端 dev 地址（见 docs/06-dev-setup.md）。端口改动只需改这一处。
const BACKEND_ORIGIN = process.env.VITE_BACKEND_ORIGIN ?? 'http://127.0.0.1:3001'

// 远程联调开关：把 Origin/Referer 改写成后端自己的源，并补 X-Forwarded-For。
// 线上的 Nginx 反代就是这么做的（后端据此信任 loopback 代理）。本地 dev 代理
// 默认会原样转发浏览器的 Origin（localhost:5173），后端一律拒绝：
//   HTTP → 403「不允许的请求来源」；WebSocket → 握手 403。
// 只影响 dev/联调，不进构建产物。
const remoteProxy = process.env.VITE_PROXY_ORIGIN_OVERRIDE
  ? {
      origin: new URL(BACKEND_ORIGIN).origin,
      headers: {
        origin: new URL(BACKEND_ORIGIN).origin,
        referer: new URL(BACKEND_ORIGIN).origin + '/',
      },
    }
  : {}

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // dev 走代理 -> 前端代码用相对路径，dev 与 prod 同源，零 CORS。
      '/api': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
        xfwd: true,
        ...remoteProxy,
      },
      // 后端同时提供无前缀的 /health（探针用）
      '/health': {
        target: BACKEND_ORIGIN,
        changeOrigin: true,
        xfwd: true,
        ...remoteProxy,
      },
      '/ws': {
        target: BACKEND_ORIGIN.replace(/^http/, 'ws'),
        ws: true,
        changeOrigin: true,
        xfwd: true,
        ...remoteProxy,
      },
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 800,
  },
})
