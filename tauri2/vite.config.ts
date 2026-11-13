import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 前端构建配置：固定端口，避免 devUrl 失配
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // 5199：避开常见的 Vite 默认端口 5173/5174，防止其他项目的 dev server
    // 占用 5173 时，Tauri 开发窗口误加载到别人的页面（2026-11-13 实际踩过）。
    port: 5199,
    strictPort: true,
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
});
