import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Separate web entry: the Electron main/preload and desktop startup are never executed.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: '/interactive-chat/',
  plugins: [react()],
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src'), '@shared': resolve(__dirname, 'src/shared') } },
  build: { outDir: resolve(__dirname, 'out/shared-chat'), emptyOutDir: true, sourcemap: false,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/shared-chat.html') } }
})
