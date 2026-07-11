import { useEffect, useRef, useState } from 'react'

export const COMMAND_CHAT_HOLD_MS = 420

export function useCommandChatSwitcher(sessionIds: string[], selectSession: (sessionId: string) => void): boolean {
  const [visible, setVisible] = useState(false)
  const sessionIdsRef = useRef(sessionIds)
  const selectSessionRef = useRef(selectSession)
  sessionIdsRef.current = sessionIds
  selectSessionRef.current = selectSession

  useEffect(() => {
    let commandHeld = false
    let holdTimer: number | null = null
    const clearTimer = () => {
      if (holdTimer == null) return
      window.clearTimeout(holdTimer)
      holdTimer = null
    }
    const dismiss = () => {
      commandHeld = false
      clearTimer()
      setVisible(false)
    }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta') {
        if (commandHeld || event.repeat) return
        commandHeld = true
        clearTimer()
        holdTimer = window.setTimeout(() => {
          holdTimer = null
          if (commandHeld && sessionIdsRef.current.length) setVisible(true)
        }, COMMAND_CHAT_HOLD_MS)
        return
      }
      if (!event.metaKey) return
      const shortcut = commandChatShortcutIndex(event.key)
      clearTimer()
      setVisible(false)
      if (shortcut == null) return
      const sessionId = sessionIdsRef.current[shortcut]
      if (!sessionId) return
      event.preventDefault()
      event.stopPropagation()
      selectSessionRef.current(sessionId)
    }
    const keyUp = (event: KeyboardEvent) => { if (event.key === 'Meta') dismiss() }
    window.addEventListener('keydown', keyDown, true)
    window.addEventListener('keyup', keyUp, true)
    window.addEventListener('blur', dismiss)
    return () => {
      clearTimer()
      window.removeEventListener('keydown', keyDown, true)
      window.removeEventListener('keyup', keyUp, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [])

  return visible
}

export function commandChatShortcutIndex(key: string): number | null {
  return /^[1-9]$/.test(key) ? Number(key) - 1 : null
}
