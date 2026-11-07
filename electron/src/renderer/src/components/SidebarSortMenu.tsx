import { useEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ArrowUpDown, Check } from 'lucide-react'
import { t } from '@shared/i18n'
import type { SidebarSortMode } from '@shared/types'
import { useLocale } from '../lib/i18n'

const SORT_MODES: readonly SidebarSortMode[] = ['default', 'latest', 'name']
const SORT_FEEDBACK_MS = 2_000

export function SidebarSortMenu({ value, disabled, onChange }: {
  value: SidebarSortMode
  disabled: boolean
  onChange: (value: SidebarSortMode) => void
}) {
  useLocale()
  const [open, setOpen] = useState(false)
  const [pointerFocus, setPointerFocus] = useState(false)
  const [feedback, setFeedback] = useState<SidebarSortMode | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hoverOpened = useRef(false)
  const cancelTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null }
  const clearFeedback = () => {
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current)
    feedbackTimer.current = null
    setFeedback(null)
  }
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current)
  }, [])
  useEffect(() => { if (disabled) { cancelTimer(); setOpen(false); clearFeedback() } }, [disabled])
  const choose = (next: SidebarSortMode) => {
    if (disabled) return
    onChange(next)
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current)
    setFeedback(next)
    feedbackTimer.current = setTimeout(() => { feedbackTimer.current = null; setFeedback(null) }, SORT_FEEDBACK_MS)
  }
  const leave = () => {
    cancelTimer()
    // Keyboard menus stay open until selection, Escape or outside click.
    if (hoverOpened.current) timer.current = setTimeout(() => setOpen(false), 200)
  }
  const cycle = () => {
    if (disabled) return
    cancelTimer()
    hoverOpened.current = false
    setOpen(false)
    choose(SORT_MODES[(SORT_MODES.indexOf(value) + 1) % SORT_MODES.length])
  }
  const feedbackText = !disabled && feedback === value ? t('sidebar.sort.feedback', { mode: t(`sidebar.sort.${value}`) }) : ''
  return <><DropdownMenu.Root modal={false} open={open && !disabled} onOpenChange={next => {
    cancelTimer()
    hoverOpened.current = false
    setOpen(next)
  }}>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="sidebar-project-action sidebar-sort-trigger" disabled={disabled}
        aria-label={t('sidebar.sort.label')} title={`${t('sidebar.sort.label')}: ${t(`sidebar.sort.${value}`)}`}
        data-sort-mode={value}
        data-pointer-focus={pointerFocus ? 'true' : undefined}
        onPointerDown={event => {
          // The trigger cycles on click, rather than using Radix's pointer-down
          // toggle. ArrowDown still opens its accessible selection menu.
          if (event.button === 0 && !event.ctrlKey) {
            setPointerFocus(true)
            event.preventDefault()
          }
        }}
        onClick={event => {
          if (event.ctrlKey) return
          if (event.detail > 0) setPointerFocus(true)
          cycle()
          event.currentTarget.focus({ preventScroll: true })
        }}
        onKeyDown={event => {
          setPointerFocus(false)
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            if (!event.repeat) cycle()
          }
        }}
        onBlur={() => setPointerFocus(false)}
        onPointerEnter={event => {
          if (disabled || open || event.pointerType !== 'mouse') return
          cancelTimer()
          timer.current = setTimeout(() => { hoverOpened.current = true; setOpen(true) }, 200)
        }}
        onPointerLeave={leave}
      ><ArrowUpDown size={14} /></button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="menu-content sidebar-sort-menu" align="start" sideOffset={4} collisionPadding={8}
        onPointerEnter={cancelTimer} onPointerLeave={leave}
        onPointerUpCapture={() => setPointerFocus(true)}
        onKeyDownCapture={() => setPointerFocus(false)}
        onCloseAutoFocus={event => { if (hoverOpened.current) event.preventDefault() }}
      >
        <DropdownMenu.Label className="menu-label">{t('sidebar.sort.label')}</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={value} onValueChange={next => {
          if (next === 'default' || next === 'latest' || next === 'name') choose(next)
        }}>
          {SORT_MODES.map(mode => <DropdownMenu.RadioItem key={mode} value={mode} className="menu-item">
            <span className="sidebar-sort-check"><DropdownMenu.ItemIndicator><Check size={14} /></DropdownMenu.ItemIndicator></span>
            {t(`sidebar.sort.${mode}`)}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
    <span className="sidebar-sort-feedback" role="status" aria-live="polite" aria-atomic="true" title={feedbackText || undefined}>{feedbackText}</span>
  </>
}
