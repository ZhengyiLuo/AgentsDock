import type { MenuItemConstructorOptions } from 'electron'
import { t } from '../shared/i18n'
import { localizeNativeMenu } from './native-menu'

export type EditHistoryCommand = 'undo' | 'redo'

export function createEditMenu(
  send: (command: EditHistoryCommand) => void,
  platform: NodeJS.Platform = process.platform
): MenuItemConstructorOptions {
  const commonItems: MenuItemConstructorOptions[] = [
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' }
  ]
  const platformItems: MenuItemConstructorOptions[] = platform === 'darwin'
    ? [
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
        { type: 'separator' },
        {
          label: t('native.speech'),
          submenu: [
            { role: 'startSpeaking' },
            { role: 'stopSpeaking' }
          ]
        }
      ]
    : [
        { role: 'delete' },
        { type: 'separator' },
        { role: 'selectAll' }
      ]

  return {
    label: t('native.edit'),
    submenu: localizeNativeMenu([
      {
        label: t('native.undo'),
        accelerator: 'CmdOrCtrl+Z',
        registerAccelerator: false,
        click: () => send('undo')
      },
      {
        label: t('native.redo'),
        accelerator: platform === 'darwin' ? 'CmdOrCtrl+Shift+Z' : 'CmdOrCtrl+Y',
        registerAccelerator: false,
        click: () => send('redo')
      },
      { type: 'separator' },
      ...commonItems,
      ...platformItems
    ])
  }
}
