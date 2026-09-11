import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const selectorPath = fileURLToPath(new URL('../select_electron_beta_release.mjs', import.meta.url))

describe('select_electron_beta_release CLI', () => {
  it('prints the SemVer-greatest compatible beta from stdin', () => {
    const result = spawnSync(process.execPath, [selectorPath], {
      encoding: 'utf8',
      input: '<feed>' +
        '<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v0.2.11" /></entry>' +
        '<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v0.2.11-beta.2" /></entry>' +
        '<entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v0.2.11-beta.12" /></entry>' +
        '</feed>'
    })

    assert.equal(result.status, 0)
    assert.equal(result.stdout, '0.2.11-beta.12\n')
    assert.equal(result.stderr, '')
  })

  it('fails closed when the feed has no compatible beta', () => {
    const result = spawnSync(process.execPath, [selectorPath], {
      encoding: 'utf8',
      input: '<feed><entry><link href="https://github.com/ZhengyiLuo/AgentsDock-Releases/releases/tag/v0.2.11" /></entry></feed>'
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /No compatible AgentsDock beta/)
  })
})
