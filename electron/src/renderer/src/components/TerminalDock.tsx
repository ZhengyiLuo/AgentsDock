import { useEffect, useState } from 'react'
import type { Session } from '@shared/types'
import { TerminalWorkspace } from './TerminalWorkspace'

export const TERMINAL_DOCK_ANIMATION_MS = 220

export function TerminalDock({
  session,
  open,
  onRequestClose
}: {
  session: Session
  open: boolean
  onRequestClose: () => void
}) {
  const [mounted, setMounted] = useState(open)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    setRevealed(false)
    const timer = window.setTimeout(() => setMounted(false), TERMINAL_DOCK_ANIMATION_MS)
    return () => window.clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!mounted || !open) return
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setRevealed(true))
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      if (secondFrame) window.cancelAnimationFrame(secondFrame)
    }
  }, [mounted, open])

  return <div
    className={`terminal-dock-shell${revealed ? ' open' : ''}`}
    aria-hidden={!open}
  >
    {mounted && <TerminalWorkspace session={session} onClose={onRequestClose} />}
  </div>
}
