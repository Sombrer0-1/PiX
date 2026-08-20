import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  root: '.',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['src/renderer/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/main/**'],
  },
})
