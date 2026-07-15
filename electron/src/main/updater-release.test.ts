import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('direct release contract', () => {
  const packageJSON = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    build: {
      mac: { target: string[]; artifactName: string }
      publish: Array<{ provider: string; owner: string; repo: string; releaseType: string }>
    }
  }
  const releaseScript = readFileSync(resolve(process.cwd(), '../scripts/build_electron_release.sh'), 'utf8')

  it('keeps updater artifacts and a public read-only GitHub feed', () => {
    expect(packageJSON.build.mac.target).toEqual(expect.arrayContaining(['zip', 'dmg']))
    expect(packageJSON.build.mac.artifactName).toContain('${version}')
    expect(packageJSON.build.mac.artifactName).toContain('${arch}')
    expect(packageJSON.build.publish).toEqual([{
      provider: 'github',
      owner: 'ZhengyiLuo',
      repo: 'ZenithBotServer',
      releaseType: 'draft'
    }])
  })

  it('builds locally without publishing and verifies before handoff', () => {
    expect(releaseScript).toContain('--publish never')
    expect(releaseScript).toContain('--config.mac.notarize=true')
    expect(releaseScript).toContain('verify_electron_release.sh')
    expect(releaseScript).not.toContain('GH_TOKEN')
  })
})
