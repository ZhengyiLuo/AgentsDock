import { useEffect, useState } from 'react'
import { Inspector } from './Inspector'

export const INSPECTOR_DOCK_ANIMATION_MS = 220

export function InspectorDock({ open, contentKey }: { open: boolean; contentKey: string }) {
  const [mounted, setMounted] = useState(open)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      return
    }
    setRevealed(false)
    const timer = window.setTimeout(() => setMounted(false), INSPECTOR_DOCK_ANIMATION_MS)
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
    className={`inspector-dock-shell${revealed ? ' open' : ''}`}
    aria-hidden={!open}
  >
    {mounted && <Inspector key={contentKey} />}
  </div>
}
