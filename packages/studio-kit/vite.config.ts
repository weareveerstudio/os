// Vite+ per-package settings: the `build` (type-check only) and `test` tasks `vp run` executes.
// Tasks rather than package.json scripts, as in custom-gatekeeper: each reads paths it also writes,
// which vp declines to cache unless the scratch paths are excluded.

// Written and read back by every vitest run. Workspace-wide because tracking reaches past the
// package; see cloudflare-os/scripts/vitest-task-vite-config.ts for each path.
const vitestScratch = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
  { pattern: '!**/.wrangler/**', base: 'workspace' },
] as const

export default {
  run: {
    tasks: {
      build: {
        command: [
          'tsc -p tsconfig.json',
          'tsc -p tsconfig.app.json',
          'tsc -p tsconfig.node.json',
        ].join(' && '),
      },
      test: {
        command: [
          'vitest run',
          'vitest run -c vitest.node.config.ts',
          'vitest run -c vitest.app.config.ts',
        ].join(' && '),
        cache: {
          input: [{ auto: true }, ...vitestScratch],
          output: [{ auto: true }, ...vitestScratch],
        },
      },
    },
  },
}
