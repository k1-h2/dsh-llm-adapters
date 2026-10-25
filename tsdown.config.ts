import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, 'zod'],
  },
})
