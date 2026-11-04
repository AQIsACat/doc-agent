import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite' // 1. 引入插件

export default defineConfig({
  plugins: [react(), tailwindcss()], // 2. 加入到 plugins 数组
})