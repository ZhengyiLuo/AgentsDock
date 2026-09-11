import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const entrypoint = process.argv[2] ?? 'src/lib/history.test.ts'
const nativeMocks = process.argv.includes('--native-mocks')
const outfile = join(tmpdir(), `agentsdock-mobile-test-${process.pid}.mjs`)
const nativeAliases = new Map(Object.entries({
  zustand: 'tests/mocks/zustand.ts',
  'react-native': 'tests/mocks/react-native.ts',
  'expo-file-system': 'tests/mocks/expo-file-system.ts',
  'expo-notifications': 'tests/mocks/expo-notifications.ts',
  '@react-native-async-storage/async-storage': 'tests/mocks/async-storage.ts',
  'expo-secure-store': 'tests/mocks/secure-store.ts',
}).map(([specifier, target]) => [specifier, resolve(target)]))
try {
  await build({
    entryPoints: [entrypoint],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: nativeMocks ? [{
      name: 'agentsdock-native-test-mocks',
      setup(context) {
        context.onResolve({ filter: /.*/ }, args => {
          const path = nativeAliases.get(args.path)
          return path ? { path } : undefined
        })
      },
    }] : [],
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await unlink(outfile).catch(() => undefined)
}
