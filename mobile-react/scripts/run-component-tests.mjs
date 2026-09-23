import { mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const entrypoint = process.argv[2]
if (!entrypoint) throw new Error('Pass a rendered component test entrypoint, such as tests/codex-server-settings.test.tsx')
// The mobile worktree and its parent staging directory live on the external
// volume. An explicit TMPDIR can direct temporary bundles elsewhere on it.
const directory = await mkdtemp(join(process.env.TMPDIR || resolve(projectRoot, '../..'), 'agentsdock-component-tests-'))
const outfile = join(directory, 'test.mjs')
const aliases = new Map(Object.entries({
  'react-native': 'tests/component-mocks/react-native.ts',
  'react-native-safe-area-context': 'tests/component-mocks/native-wrappers.ts',
  'react-native-svg': 'tests/component-mocks/native-wrappers.ts',
  'react-native-keyboard-controller': 'tests/component-mocks/native-wrappers.ts',
  'lucide-react-native': 'tests/component-mocks/icons.ts',
  'expo-file-system': 'tests/mocks/expo-file-system.ts',
  '@expo/ui/community/menu': 'tests/component-mocks/native-wrappers.ts',
}).map(([name, path]) => [name, resolve(projectRoot, path)]))

try {
  await build({
    absWorkingDir: projectRoot,
    entryPoints: [entrypoint],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.png': 'dataurl' },
    logLevel: 'silent',
    banner: {
      js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(import.meta.url)});\n`
        + 'globalThis.IS_REACT_ACT_ENVIRONMENT = true;\n'
        + 'globalThis.requestAnimationFrame ??= callback => setTimeout(() => callback(Date.now()), 0);\n'
        + 'globalThis.cancelAnimationFrame ??= clearTimeout;',
    },
    plugins: [{
      name: 'isolated-native-component-tests',
      setup(context) {
        // Keep React's Node scheduler intact. Bundling React erases its dynamic
        // module.require('timers'), causing act() to retain MessageChannel ports.
        context.onResolve({ filter: /^(?:react|react-test-renderer|zustand)(?:\/.*)?$/ }, args => ({
          path: require.resolve(args.path),
          external: true,
        }))
        context.onResolve({ filter: /.*/ }, args => {
          const alias = aliases.get(args.path)
          if (alias) return { path: alias }
          if (/(?:^|\/)store\/useAppStore(?:\.[jt]sx?)?$/.test(args.path)) {
            return { path: resolve(projectRoot, 'tests/component-mocks/app-store.ts') }
          }
          return undefined
        })
      },
    }],
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(directory, { recursive: true, force: true })
}
