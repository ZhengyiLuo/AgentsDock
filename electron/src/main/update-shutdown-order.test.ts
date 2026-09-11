import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('desktop update shutdown order', () => {
  it('keeps the active service alive until window close persistence completes', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const updaterWiring = source.slice(source.indexOf('const updater ='), source.indexOf('app.whenReady()'))
    const quitLifecycle = source.slice(source.indexOf("app.on('will-quit'"))

    expect(updaterWiring).not.toContain('service?.stop()')
    expect(quitLifecycle).toContain('service?.stop()')
  })
})
