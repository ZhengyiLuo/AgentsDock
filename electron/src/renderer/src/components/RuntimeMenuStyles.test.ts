import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const styles = readFileSync(resolve(process.cwd(), 'src/renderer/src/styles.css'), 'utf8')

describe('runtime menu styles', () => {
  it('bounds long server model catalogs and lets them scroll', () => {
    expect(styles).toMatch(
      /\.runtime-menu \{[^}]*max-height: min\(480px, calc\(100vh - 100px\)\);[^}]*overflow-y: auto;/s
    )
  })

  it('keeps upgrade-only models visibly explained', () => {
    expect(styles).toMatch(/\.menu-item-locked-hint \{[^}]*font-size:/s)
  })
})
