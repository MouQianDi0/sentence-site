// 前端构建：Vite + Tailwind CSS v4。npm run dev 本地预览（/api 转给后端），npm run build 输出到 dist/
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

// 本地开发时后端的地址：npm run dev:api 是 3000，npm run dev:demo（假模型 + 本机 PostgreSQL）是 3100
const api = process.env.API_URL || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: api, changeOrigin: false } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 国内手机浏览器（微信、QQ、UC）内核都不算新，按 2020 年以后的浏览器编译
    target: ['es2020', 'chrome87', 'safari14'],
    assetsInlineLimit: 0,
  },
});
