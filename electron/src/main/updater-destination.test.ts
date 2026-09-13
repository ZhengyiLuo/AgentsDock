import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(process.cwd(), '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')
const packageJSON = JSON.parse(read('electron/package.json'))

function packagedUpdateValidator(script: string): string {
  // Windows checkouts may convert shell sources to CRLF. Normalize the fixture,
  // not the checked-in script, before locating and executing its real guard.
  const validator = script.replace(/\r\n/g, '\n').match(/node - "\$JS_YAML" "\$(?:UPDATE_CONFIG|APPIMAGE_UPDATE_CONFIG)" "\$EXPECTED_CHANNEL" <<'NODE'\n([\s\S]*?)\nNODE/)?.[1]
  if (!validator) throw new Error('Packaged updater validation must run in the platform verifier')
  return validator
}

describe('desktop release destination migration', () => {
  let fixtureDirectory: string
  let yamlPath: string

  beforeAll(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'agentsdock-update-config-'))
    const dependencies = resolve(root, 'electron/node_modules/.pnpm')
    const yamlPackage = readdirSync(dependencies).find((name) => name.startsWith('js-yaml@'))
    if (!yamlPackage) throw new Error('Install Electron dependencies before running updater configuration verification')
    yamlPath = join(dependencies, yamlPackage, 'node_modules/js-yaml/index.js')
  })

  afterAll(() => {
    if (fixtureDirectory) rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  it('keeps the existing app identity while embedding only the canonical desktop feed', () => {
    expect(packageJSON.name).toBe('agentsdock-electron')
    expect(packageJSON.build.appId).toBe('com.zhengyiluo.AgentsDock')
    expect(packageJSON.build.publish).toEqual([expect.objectContaining({
      provider: 'github', owner: 'ZhengyiLuo', repo: 'AgentsDock'
    })])
    expect(packageJSON.build.nsis.deleteAppDataOnUninstall).toBe(false)
  })

  for (const platform of ['release', 'linux']) {
    describe(`${platform} packaged update configuration`, () => {
      const script = read(`scripts/verify_electron_${platform}.sh`)

      function validate(source: string, overrides: Record<string, unknown>, expectedChannel: string) {
        const validator = packagedUpdateValidator(source)
        const configPath = join(fixtureDirectory, `${platform}-app-update.yml`)
        // JSON is valid YAML; execute the actual verifier's parser and guard.
        writeFileSync(configPath, JSON.stringify({
          provider: 'github', owner: 'ZhengyiLuo', repo: 'AgentsDock', channel: expectedChannel, ...overrides
        }))
        return spawnSync(process.execPath, ['-', yamlPath, configPath, expectedChannel], { input: validator, encoding: 'utf8' })
      }

      for (const [lineEndingName, lineEnding] of [['LF', '\n'], ['CRLF', '\r\n']]) {
        const fixture = script.replace(/\r?\n/g, lineEnding)
        for (const channel of ['latest', 'beta']) {
          it(`accepts the ${channel} channel only at the public source repository (${lineEndingName} checkout)`, () => {
            expect(packagedUpdateValidator(fixture)).not.toContain('\r')
            expect(validate(fixture, {}, channel).status).toBe(0)
            expect(validate(fixture, { repo: 'AgentsDock-Releases' }, channel).status).toBe(2)
            expect(validate(fixture, { repo: 'AgentsDock-Internal' }, channel).status).toBe(2)
            expect(validate(fixture, { owner: 'someone-else' }, channel).status).toBe(2)
            expect(validate(fixture, { channel: channel === 'beta' ? 'latest' : 'beta' }, channel).status).toBe(2)
          })
        }
      }

      it('checks an explicitly stamped release build without disabling local verification', () => {
        expect(script).toContain('${AGENTSDOCK_EXPECTED_BUILD_NUMBER:-}')
        expect(script).toContain(platform === 'release' ? 'CFBundleVersion' : 'releaseBuildNumber')
      })
    })
  }

  it('keeps Windows on the same feed and verifies an explicitly stamped build', () => {
    const script = read('scripts/verify_electron_windows.ps1')
    expect(script).toContain("(Read-TopLevelYamlScalar $UpdateText 'repo') -eq 'AgentsDock'")
    expect(script).not.toContain("-eq 'AgentsDock-Releases'")
    expect(script).toContain('if ($env:AGENTSDOCK_EXPECTED_BUILD_NUMBER)')
    expect(script).toContain("$PackageJson.PSObject.Properties['releaseBuildNumber']")
    expect(script).toContain('[string]$PackageJson.releaseBuildNumber -eq $env:AGENTSDOCK_EXPECTED_BUILD_NUMBER')
  })

  it('keeps the published stable downloads separate from the public beta catalog', () => {
    const manifest = JSON.parse(read('website/releases/latest.json'))
    const homepage = read('website/index.html')
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/)
    for (const platform of ['macos', 'linux']) {
      const artifact = manifest.platforms[platform]
      expect(artifact.url).toContain(`/releases/download/v${manifest.version}/`)
      expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(homepage).toContain(artifact.url)
    }
    expect(homepage).toContain('https://github.com/ZhengyiLuo/AgentsDock/releases')
    expect(homepage).toContain('Desktop beta releases')
  })

  it('does not move Android to the desktop feed', () => {
    expect(read('mobile-react/src/lib/android-update.ts')).toContain('AgentsDock-Releases')
    expect(read('README.md')).toContain('AgentsDock-Releases/releases/download/android-')
  })
})
