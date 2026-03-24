import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['lib/__tests__/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
})
