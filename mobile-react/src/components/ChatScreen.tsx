import { useEffect, useMemo, useState } from 'react'
import { AppState, Keyboard, Platform, StyleSheet, View, useWindowDimensions, type KeyboardEvent, type KeyboardMetrics } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePalette } from '../theme'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { Timeline } from './Timeline'
import { RuntimeHealthNotice } from './RuntimeHealth'
import { useAppStore } from '../store/useAppStore'

export function ChatScreen({ sessionId, compact, onBack, onOptions, onSearch, onToggleInspector, onReview }: { sessionId: string; compact: boolean; onBack: () => void; onOptions: () => void; onSearch: () => void; onToggleInspector: () => void; onReview: (runId: string) => void }) {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = useWindowDimensions()
  const [scrollRequest, setScrollRequest] = useState(0)
  const [keyboardFrame, setKeyboardFrame] = useState<KeyboardMetrics | null>(null)
  const [composerHeight, setComposerHeight] = useState(0)
  const backend = useAppStore(state => state.sessions.find(value => value.id === sessionId)?.backend)
  const keyboardVisible = keyboardFrame != null
  const keyboardInset = useMemo(() => {
    if (Platform.OS !== 'ios' || keyboardFrame == null) return 0
    const overlap = Math.max(0, windowHeight - keyboardFrame.screenY)
    const frameHeight = Math.max(0, keyboardFrame.height)
    const saneOverlap = overlap > windowHeight * 0.72 ? frameHeight : overlap
    return Math.min(Math.max(0, saneOverlap), windowHeight * 0.62)
  }, [keyboardFrame, windowHeight])
  const timelineBottomInset = composerHeight + keyboardInset
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', (event: KeyboardEvent) => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardFrame(event.endCoordinates)
    })
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', (event: KeyboardEvent) => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardFrame(null)
    })
    return () => { show.remove(); hide.remove() }
  }, [])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') setKeyboardFrame(null)
    })
    return () => subscription.remove()
  }, [])
  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <ChatHeader sessionId={sessionId} compact={compact} onBack={onBack} onOptions={onOptions} onSearch={onSearch} onToggleInspector={onToggleInspector} />
    {backend ? <RuntimeHealthNotice backend={backend} /> : null}
    <View style={styles.body}>
      <View style={styles.timeline}>
        <Timeline sessionId={sessionId} scrollRequest={scrollRequest} keyboardVisible={keyboardVisible} bottomInset={timelineBottomInset} onReview={onReview} />
      </View>
      <View
        onLayout={event => setComposerHeight(Math.ceil(event.nativeEvent.layout.height))}
        style={[styles.composerDock, { bottom: keyboardInset, paddingBottom: keyboardVisible ? 0 : insets.bottom }]}
      >
        <Composer sessionId={sessionId} onSent={() => setScrollRequest(value => value + 1)} />
      </View>
    </View>
  </View>
}
const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
  timeline: { flex: 1, minHeight: 0 },
  composerDock: { position: 'absolute', left: 0, right: 0 },
})
