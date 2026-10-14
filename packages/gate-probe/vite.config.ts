// Vite+ per-package settings: the tasks `vp run` executes. scripts/deploy.ts builds this package
// with `vp run -F @veer/gate-probe --no-cache build`; `--no-cache` reaches `build:app` through
// `dependsOn`, so a deploy always rebuilds the app from source.

// Written and read back by every vitest run. Workspace-wide because tracking reaches past the
// package; see cloudflare-os/scripts/vitest-task-vite-config.ts for each path.
const vitestScratch = [
  { pattern: '!**/node_modules/.vite/**', base: 'workspace' },
  { pattern: '!**/node_modules/.vite-temp/**', base: 'workspace' },
  { pattern: '!**/.wrangler/**', base: 'workspace' },
] as const

// The app build writes dist-app/ and src/generated/ back into the package, so both are excluded
// from its own fingerprint (workspace-wide, so sibling gates' outputs are excluded too).
const appOutputs = [
  { pattern: '!**/dist-app/**', base: 'workspace' },
  { pattern: '!**/src/generated/**', base: 'workspace' },
] as const

export default {
  run: {
    tasks: {
      'build:app': {
        command: 'node build-app.ts',
        cache: {
          input: [{ auto: true }, ...appOutputs, { pattern: '!**/.wrangler/**', base: 'workspace' }],
          output: ['dist-app/**', 'src/generated/app.txt'],
        },
      },
      build: {
        command: [
          'tsc -p tsconfig.json',
          'tsc -p tsconfig.test.json',
          'tsc -p tsconfig.app.json',
          'tsc -p tsconfig.node.json',
        ].join(' && '),
        dependsOn: ['build:app'],
      },
      test: {
        command: 'vitest run && vitest run -c vitest.app.config.ts',
        dependsOn: ['build:app'],
        cache: {
          input: [{ auto: true }, ...appOutputs, ...vitestScratch],
          output: [{ auto: true }, ...appOutputs, ...vitestScratch],
        },
      },
    },
  },
}
