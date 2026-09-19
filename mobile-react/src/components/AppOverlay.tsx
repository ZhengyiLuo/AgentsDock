import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BackHandler, StyleSheet, View } from 'react-native'

type Entry = {
  id: symbol
  children: ReactNode
  onClose: () => void
  onShow?: () => void
  onDidDismiss?: () => void
}
type OverlayRegistry = { update: (entry: Entry) => void; remove: (id: symbol) => void }
const OverlayContext = createContext<OverlayRegistry | null>(null)

/** Keep transient pickers on the app's touch surface, outside chat gestures. */
export function AppOverlayProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Entry[]>([])
  const previousEntries = useRef<Entry[]>([])
  const update = useCallback((entry: Entry) => {
    setEntries(current => {
      const index = current.findIndex(value => value.id === entry.id)
      return index < 0 ? [...current, entry] : current.map((value, position) => position === index ? entry : value)
    })
  }, [])
  const remove = useCallback((id: symbol) => {
    setEntries(current => current.some(entry => entry.id === id) ? current.filter(entry => entry.id !== id) : current)
  }, [])
  // The registry never changes when its content changes. Publishing a picker
  // must not render its source again and cause a registration/render loop.
  const registry = useMemo(() => ({ update, remove }), [update, remove])
  const active = entries.at(-1)
  const activeRef = useRef(active)
  activeRef.current = active

  useLayoutEffect(() => {
    const removed = previousEntries.current.filter(previous => !entries.some(entry => entry.id === previous.id))
    previousEntries.current = entries
    // Run only after the host committed removal, never on a content update or
    // when another overlay merely covers this one. Focus restoration can now
    // use the real React lifecycle without waiting for a UIKit onDismiss.
    for (const entry of removed) entry.onDidDismiss?.()
  }, [entries])

  useEffect(() => {
    if (!active) return
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      const current = activeRef.current
      if (!current) return false
      current.onClose()
      return true
    })
    return () => subscription.remove()
  }, [active?.id])

  return <OverlayContext.Provider value={registry}>
    <View style={styles.root}>
      <View testID="app-overlay-underlay" style={styles.root} pointerEvents={active ? 'none' : 'auto'} accessibilityElementsHidden={Boolean(active)} importantForAccessibility={active ? 'no-hide-descendants' : 'auto'}>
        {children}
      </View>
      {active ? <OverlaySurface entry={active} /> : null}
    </View>
  </OverlayContext.Provider>
}

function OverlaySurface({ entry }: { entry: Entry }) {
  const onShow = useRef(entry.onShow)
  onShow.current = entry.onShow
  useLayoutEffect(() => { onShow.current?.() }, [entry.id])
  return <View testID="app-overlay-surface" collapsable={false} accessibilityViewIsModal importantForAccessibility="yes" onAccessibilityEscape={entry.onClose} style={styles.surface}>
    {entry.children}
  </View>
}

export function AppOverlay({ visible, children, onClose, onShow, onDidDismiss }: Omit<Entry, 'id'> & { visible: boolean }) {
  const registry = useContext(OverlayContext)
  const id = useRef(Symbol('app-overlay')).current
  useLayoutEffect(() => {
    if (!registry) return
    if (visible) registry.update({ id, children, onClose, onShow, onDidDismiss })
    else registry.remove(id)
  }, [registry, id, visible, children, onClose, onShow, onDidDismiss])
  useLayoutEffect(() => () => registry?.remove(id), [registry, id])
  if (!registry && visible) throw new Error('AppOverlay requires AppOverlayProvider')
  return null
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  surface: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, zIndex: 1000, elevation: 1000 },
})
