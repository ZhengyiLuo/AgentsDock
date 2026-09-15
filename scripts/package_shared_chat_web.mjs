import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve, relative, extname } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createHash } from 'node:crypto'

// Compile first with: pnpm exec vite build --config vite.shared-chat.config.ts
// Explicit output only; this does not deploy, publish, or touch an installed server.
const [input, output] = process.argv.slice(2)
if (!input || !output || !output.endsWith('.py')) throw new Error('Usage: node scripts/package_shared_chat_web.mjs <built-web-directory> <output.py>')
const root = resolve(input)
const media = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png' }
const assets = {}
async function readRegular(path, encoding) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Web inputs must be regular files, not links or devices')
  return readFile(path, encoding)
}
async function visit(path) {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Web asset directories must not be links')
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error('Web assets must be regular files or directories')
    const full = resolve(path, entry.name)
    if (entry.isDirectory()) await visit(full)
    else {
      const name = relative(resolve(root, 'assets'), full).replaceAll('\\', '/')
      if (!/^[A-Za-z0-9_./-]+$/.test(name) || name.split('/').includes('..') || !media[extname(name)]) throw new Error('Unexpected web asset')
      assets[name] = [media[extname(name)], (await readRegular(full)).toString('base64')]
    }
  }
}
await visit(resolve(root, 'assets'))
for (const backend of ['codex', 'claude', 'cursor']) {
  const name = `backend-${backend}.png`
  assets[name] = ['image/png', (await readRegular(resolve(root, name))).toString('base64')]
}
const html = await readRegular(resolve(root, 'shared-chat.html'), 'utf8')
const data = Buffer.from(JSON.stringify({ html, assets }))
const encoded = deflateSync(data, { level: 9 }).toString('base64')
const hash = createHash('sha256').update(data).digest('hex')
await writeFile(resolve(output), `"""Generated from the AgentsDock shared renderer. Do not edit bundled assets by hand."""\nimport base64\nimport json\nimport zlib\n\nSOURCE_SHA256 = ${JSON.stringify(hash)}\n_payload = json.loads(zlib.decompress(base64.b64decode(${JSON.stringify(encoded)})))\nHTML = _payload['html']\nASSETS = {name: (value[0], base64.b64decode(value[1])) for name, value in _payload['assets'].items()}\nJAVASCRIPT = ''\nCSS = ''\ndel _payload\n`)
process.stdout.write(JSON.stringify({ assets: Object.keys(assets).length, source_sha256: hash, bytes: data.length }) + '\n')
