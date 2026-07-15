import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const outfile = join(tmpdir(), `agentsdock-mobile-history-${process.pid}.mjs`)
try {
  await build({
    entryPoints: ['src/lib/history.test.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await unlink(outfile).catch(() => undefined)
}

