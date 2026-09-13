import * as Tooltip from '@radix-ui/react-tooltip'
import type { ReactElement } from 'react'
import { t } from '@shared/i18n'
import { APP_SHORTCUTS, shortcutDisplay, shortcutIsAvailable, type AppShortcutId, type ShortcutPlatform } from '@shared/shortcuts'

export function ShortcutKey({
  shortcut,
  platform = currentShortcutPlatform()
}: {
  shortcut: AppShortcutId
  platform?: ShortcutPlatform
}) {
  return <kbd>{shortcutDisplay(shortcut, platform)}</kbd>
}

export function ShortcutTooltip({
  shortcut,
  label,
  children,
  side = 'bottom',
  platform = currentShortcutPlatform()
}: {
  shortcut: AppShortcutId | readonly AppShortcutId[]
  label?: string
  children: ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  platform?: ShortcutPlatform
}) {
  const shortcuts: readonly AppShortcutId[] = typeof shortcut === 'string' ? [shortcut] : shortcut
  const resolvedLabel = label ?? APP_SHORTCUTS[shortcuts[0]].label
  return <Tooltip.Provider delayDuration={350}>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="shortcut-tooltip" side={side} sideOffset={7} collisionPadding={8}>
          <span>{resolvedLabel}</span>
          <span className="shortcut-tooltip-keys">{shortcuts.map(id => shortcutIsAvailable(id, platform)
            ? <kbd key={id}>{shortcutDisplay(id, platform)}</kbd>
            : <span key={id} className="shortcut-tooltip-platform-note">{t('shortcuts.macOnly')}</span>)}</span>
          <Tooltip.Arrow className="shortcut-tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  </Tooltip.Provider>
}

export function currentShortcutPlatform(): ShortcutPlatform {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(`${navigator.platform} ${navigator.userAgent}`) ? 'mac' : 'other'
}
