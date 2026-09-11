import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [appPath, identity, mainEntitlements, inheritEntitlements, signingMode = 'developer-id'] = process.argv.slice(2)
if (![appPath, identity, mainEntitlements, inheritEntitlements].every(Boolean) || !['developer-id', 'adhoc'].includes(signingMode)) {
  throw new Error('Usage: sign_electron_local.mjs APP IDENTITY MAIN_ENTITLEMENTS INHERIT_ENTITLEMENTS [developer-id|adhoc]')
}

const root = resolve(import.meta.dirname, '..')
const signerPath = resolve(root, 'electron/node_modules/@electron/osx-sign/dist/index.js')
const { sign } = await import(pathToFileURL(signerPath).href)
const app = resolve(appPath)
const main = resolve(mainEntitlements)
const inherit = resolve(inheritEntitlements)
const adHoc = signingMode === 'adhoc'

if (adHoc !== (identity === '-')) {
  throw new Error('Ad-hoc signing must use identity "-"; Developer ID signing must use a certificate identity.')
}

await sign({
  app,
  identity,
  platform: 'darwin',
  type: 'distribution',
  identityValidation: !adHoc,
  timestamp: adHoc ? 'none' : undefined,
  preAutoEntitlements: false,
  preEmbedProvisioningProfile: false,
  optionsForFile: filePath => ({
    entitlements: resolve(filePath) === app ? main : inherit,
    hardenedRuntime: true,
    signatureFlags: 'runtime'
  })
})
