import { useEffect, useState } from 'react'
import { AppState, Keyboard, KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native'
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
  const [scrollRequest, setScrollRequest] = useState(0)
  const [keyboardVisible, setKeyboardVisible] = useState(false)
  const backend = useAppStore(state => state.sessions.find(value => value.id === sessionId)?.backend)
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', event => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardVisible(true)
    })
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', event => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardVisible(false)
    })
    return () => { show.remove(); hide.remove() }
  }, [])
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') setKeyboardVisible(false)
    })
    return () => subscription.remove()
  }, [])
  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <ChatHeader sessionId={sessionId} compact={compact} onBack={onBack} onOptions={onOptions} onSearch={onSearch} onToggleInspector={onToggleInspector} />
    {backend ? <RuntimeHealthNotice backend={backend} /> : null}
    <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.timeline}>
        <Timeline sessionId={sessionId} scrollRequest={scrollRequest} keyboardVisible={keyboardVisible} bottomInset={0} onReview={onReview} />
      </View>
      <View style={[styles.composerDock, { paddingBottom: keyboardVisible ? 0 : insets.bottom }]}>
        <Composer sessionId={sessionId} onSent={() => setScrollRequest(value => value + 1)} />
      </View>
    </KeyboardAvoidingView>
  </View>
}
const styles = StyleSheet.create({
  root: { flex: 1, minWidth: 0 },
  body: { flex: 1, minHeight: 0 },
  timeline: { flex: 1, minHeight: 0, overflow: 'hidden' },
  composerDock: { flexShrink: 0 },
})
