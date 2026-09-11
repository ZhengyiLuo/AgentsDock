import { useEffect, useState } from 'react'
import type { WorkspaceProfileScope } from '@shared/types'
import { useAppStore } from '../store/app-store'
import { getWorkspacePreference, setWorkspacePreference } from './workspace-preferences'

export const CHAT_FONT_SIZES = [13, 14, 15, 16, 18, 20, 22, 24]
export const CHAT_FONT_FAMILIES: Array<[value: string, label: string]> = [
  ['system', 'System'],
  ['rounded', 'Rounded'],
  ['mono', 'Monospaced']
]
export const DEFAULT_CHAT_FONT_SIZE = 14
export const DEFAULT_CHAT_FONT_FAMILY = 'system'

let currentSize = DEFAULT_CHAT_FONT_SIZE
let currentFamily = DEFAULT_CHAT_FONT_FAMILY

export function applyChatFont(size: number, family: string): void {
  currentSize = size
  currentFamily = family
  document.documentElement.style.setProperty('--chat-font-size', `${size}px`)
  document.documentElement.style.setProperty(
    '--chat-font-family',
    family === 'mono'
      ? '"SFMono-Regular", Menlo, monospace'
      : family === 'rounded'
        ? 'ui-rounded, "SF Pro Rounded", -apple-system, sans-serif'
        : '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
  )
}

function readChatFontScope(): WorkspaceProfileScope | null {
  const state = useAppStore.getState()
  return state.activeProfileId
    ? { profileId: state.activeProfileId, profileGeneration: state.profileGeneration, serverIdentity: state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null }
    : null
}

/** Imperative size stepper for the native View menu (delta of ±1 step). */
export function nudgeChatFontSize(delta: number): void {
  const index = CHAT_FONT_SIZES.indexOf(currentSize)
  const base = index >= 0 ? index : CHAT_FONT_SIZES.indexOf(DEFAULT_CHAT_FONT_SIZE)
  const next = CHAT_FONT_SIZES[Math.max(0, Math.min(CHAT_FONT_SIZES.length - 1, base + delta))]
  setChatFontSize(next)
}

/** Imperative exact-size setter for the native View menu. */
export function setChatFontSize(size: number): void {
  if (!CHAT_FONT_SIZES.includes(size) || size === currentSize) return
  applyChatFont(size, currentFamily)
  void setWorkspacePreference(readChatFontScope(), 'chatFontSize', size).catch(() => undefined)
}

/** Imperative typeface setter for the native View menu. */
export function setChatFontFamily(family: string): void {
  applyChatFont(currentSize, family)
  void setWorkspacePreference(readChatFontScope(), 'chatFontFamily', family).catch(() => undefined)
}

function useChatFontScope(): WorkspaceProfileScope | null {
  const profileId = useAppStore(state => state.activeProfileId)
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const serverIdentity = useAppStore(state => state.profiles.find(profile => profile.id === state.activeProfileId)?.serverIdentity ?? null)
  return profileId ? { profileId, profileGeneration, serverIdentity } : null
}

/**
 * Loads and applies the saved chat font whenever the active server profile
 * changes, and exposes the current values plus an updater for settings UI.
 */
export function useChatFontController() {
  const scope = useChatFontScope()
  const scopeKey = scope ? `${scope.profileId}:${scope.profileGeneration}:${scope.serverIdentity ?? ''}` : ''
  const [size, setSize] = useState(DEFAULT_CHAT_FONT_SIZE)
  const [family, setFamily] = useState(DEFAULT_CHAT_FONT_FAMILY)
  useEffect(() => {
    void Promise.all([
      getWorkspacePreference(scope, 'chatFontSize', DEFAULT_CHAT_FONT_SIZE),
      getWorkspacePreference(scope, 'chatFontFamily', DEFAULT_CHAT_FONT_FAMILY)
    ]).then(([savedSize, savedFamily]) => {
      setSize(savedSize)
      setFamily(savedFamily)
      applyChatFont(savedSize, savedFamily)
    }).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey])
  const update = (nextSize = size, nextFamily = family) => {
    setSize(nextSize)
    setFamily(nextFamily)
    applyChatFont(nextSize, nextFamily)
    void setWorkspacePreference(scope, 'chatFontSize', nextSize).catch(() => undefined)
    void setWorkspacePreference(scope, 'chatFontFamily', nextFamily).catch(() => undefined)
  }
  return { size, family, update }
}

/**
 * Always-mounted, render-free applier that keeps the saved chat font applied
 * on startup and across profile switches while native View-menu controls
 * update the saved preference imperatively.
 */
export function ChatFontApplier(): null {
  useChatFontController()
  return null
}
