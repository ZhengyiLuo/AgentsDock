import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const input = process.argv[2]
assert.ok(input, 'Usage: node scripts/verify-ios-framework-abi.mjs <archive-or-app-path>')

const resolved = path.resolve(input)
assert.ok(fs.existsSync(resolved), `Archive or app does not exist: ${resolved}`)

const appPath = resolved.endsWith('.xcarchive')
  ? path.join(resolved, 'Products', 'Applications', 'AgentsDock.app')
  : resolved
const frameworksPath = path.join(appPath, 'Frameworks')
assert.ok(fs.existsSync(frameworksPath), `Frameworks directory does not exist: ${frameworksPath}`)

const frameworkBinaries = fs.readdirSync(frameworksPath, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && entry.name.endsWith('.framework'))
  .map(entry => {
    const provider = entry.name.slice(0, -'.framework'.length)
    const binary = path.join(frameworksPath, entry.name, provider)
    assert.ok(fs.existsSync(binary), `Framework binary is missing: ${binary}`)
    return { name: entry.name, provider, binary }
  })

const appExecutable = execFileSync(
  '/usr/bin/plutil',
  ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(appPath, 'Info.plist')],
  { encoding: 'utf8' },
).trim()
const consumers = [
  { name: `${path.basename(appPath)}/${appExecutable}`, binary: path.join(appPath, appExecutable) },
  ...frameworkBinaries,
]

const exportsByProvider = new Map(
  frameworkBinaries.map(framework => [framework.provider, exportedSymbols(framework.binary)]),
)

const missing = []
for (const consumer of consumers) {
  for (const imported of undefinedImports(consumer.binary)) {
    const providerExports = exportsByProvider.get(imported.provider)
    if (!providerExports || providerExports.has(imported.symbol)) continue
    missing.push(`${consumer.name} -> ${imported.provider}: ${imported.symbol}`)
  }
}

assert.deepEqual(
  missing,
  [],
  `Bundled Swift framework ABI mismatch:\n${missing.join('\n')}`,
)

console.log(
  `iOS framework ABI verified across ${consumers.length} consumers and ${frameworkBinaries.length} bundled providers`,
)

function exportedSymbols(binary) {
  const output = execFileSync('/usr/bin/nm', ['-gU', binary], { encoding: 'utf8' })
  return new Set(output.split('\n')
    .map(line => line.trim().split(/\s+/).at(-1) ?? '')
    .filter(Boolean))
}

function undefinedImports(binary) {
  const output = execFileSync('/usr/bin/nm', ['-um', binary], { encoding: 'utf8' })
  const imports = []
  for (const line of output.split('\n')) {
    const match = /\(undefined\)\s+(weak\s+)?external\s+(\S+)\s+\(from ([^)]+)\)/.exec(line)
    if (!match || match[1]) continue
    imports.push({ symbol: match[2], provider: match[3] })
  }
  return imports
}
