import type { MenuItemConstructorOptions } from 'electron'
import { t } from '../shared/i18n'
import { catalogs, defaultLocale } from '../shared/locales'

/** Electron role defaults follow the OS, so supply labels for the chosen app language. */
export function localizeNativeMenu(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.map(item => {
    const key = item.role === 'undo' || item.role === 'redo'
      ? `native.${item.role}`
      : `native.role.${item.role}`
    return {
      ...item,
      ...(!item.label && Object.hasOwn(catalogs[defaultLocale], key) ? { label: t(key) } : {}),
      ...(Array.isArray(item.submenu) ? { submenu: localizeNativeMenu(item.submenu) } : {})
    }
  })
}
