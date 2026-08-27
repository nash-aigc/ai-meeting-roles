import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// 开发模式：本机跑 Vite（HMR 秒级热更新），后端接口全部代理进 Docker gateway。
// 生产模式：vite build -> dist/ 由 gateway 容器静态托管。
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // REST 接口转发到 Docker gateway
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      // WebSocket 转发（会议主通道）
      '/ws': {
        target: 'ws://127.0.0.1:8787',
        ws: true,
      },
    },
  },
})
