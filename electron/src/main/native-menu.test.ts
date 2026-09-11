import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { setLocale, t } from '../shared/i18n'
import { localizeNativeMenu } from './native-menu'
import { createEditMenu } from './edit-menu'

afterEach(() => setLocale('en'))

describe('native menu localization', () => {
  it('localizes nested role labels without changing role behavior or accelerators', () => {
    setLocale('zh-CN')
    const click = vi.fn()
    const input: MenuItemConstructorOptions[] = [{ role: 'fileMenu', submenu: [
      { role: 'copy', accelerator: 'CmdOrCtrl+C', click },
      { role: 'close', label: 'User supplied item' }
    ] }]
    const output = localizeNativeMenu(input)
    expect(output[0].label).toBe('文件')
    expect(output[0].submenu).toEqual([
      { role: 'copy', label: '复制', accelerator: 'CmdOrCtrl+C', click },
      { role: 'close', label: 'User supplied item' }
    ])
    expect(input[0].label).toBeUndefined()
  })

  it('rebuilds menus in the selected locale while preserving edit command dispatch', () => {
    const send = vi.fn()
    setLocale('zh-CN')
    const menu = createEditMenu(send, 'darwin')
    expect(menu.label).toBe('编辑')
    const items = menu.submenu as MenuItemConstructorOptions[]
    expect(items[0]).toMatchObject({ label: '撤销', accelerator: 'CmdOrCtrl+Z', registerAccelerator: false })
    ;(items[0].click as () => void)()
    expect(send).toHaveBeenCalledWith('undo')
    setLocale('en')
    expect(createEditMenu(send).label).toBe('Edit')
  })

  it('uses conversational and font semantics in native labels', () => {
    setLocale('zh-CN')
    expect(t('native.newChat')).toBe('新建会话')
    expect(t('native.server')).toBe('服务端')
    expect(t('native.systemFont')).toBe('系统字体')
    expect(t('native.toggleInspector')).toBe('切换右侧面板')
  })
})
