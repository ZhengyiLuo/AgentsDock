import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { createEditMenu } from './edit-menu'

describe('native Edit menu', () => {
  it('shows undo and redo accelerators without registering over CodeMirror', () => {
    const send = vi.fn()
    const menu = createEditMenu(send, 'darwin')
    const items = menu.submenu as MenuItemConstructorOptions[]
    const undo = items[0]
    const redo = items[1]

    expect(undo).toMatchObject({
      label: 'Undo',
      accelerator: 'CmdOrCtrl+Z',
      registerAccelerator: false
    })
    expect(redo).toMatchObject({
      label: 'Redo',
      accelerator: 'CmdOrCtrl+Shift+Z',
      registerAccelerator: false
    })

    ;(undo.click as () => void)()
    ;(redo.click as () => void)()

    expect(send.mock.calls).toEqual([['undo'], ['redo']])
  })

  it('keeps the conventional non-Mac redo label without registering it', () => {
    const menu = createEditMenu(vi.fn(), 'linux')
    const items = menu.submenu as MenuItemConstructorOptions[]

    expect(items[1]).toMatchObject({
      accelerator: 'CmdOrCtrl+Y',
      registerAccelerator: false
    })
  })
})
