import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// resolve sibling source packages by path (not via node_modules), so a git
// worktree whose node_modules is linked to another checkout still tests
// against this checkout's edits (same convention as packages/pdf2docx)
const local = (rel: string) => fileURLToPath(new URL(rel, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@genoffice/docx-engine': local('../../packages/docx-engine/src/index.ts'),
      '@genoffice/font-metrics': local('../../packages/font-metrics/src/index.ts'),
      '@genoffice/electron-utils': local('../../packages/electron-utils/src/index.ts'),
      '@genoffice/ai-provider': local('../../packages/ai-provider/src/index.ts'),
      '@genoffice/i18n': local('../../packages/i18n/src/index.ts'),
      '@genoffice/ui': local('../../packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'jsdom',
    testTimeout: 20000,
    // Each jsdom worker loads the editor; excessive Windows parallelism starves
    // the real 100,000-round WebCrypto password tests and exhausts their timeout.
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {}),
  },
})
