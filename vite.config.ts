import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: true },
  build: {
    rollupOptions: {
      // three barely changes between builds, so let it cache on its own.
      output: { manualChunks: { three: ['three'] } },
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
