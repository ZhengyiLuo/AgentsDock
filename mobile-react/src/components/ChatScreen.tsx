import { useEffect, useState } from 'react'
import { Keyboard, Platform, StyleSheet, View, useWindowDimensions, type KeyboardEvent } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { usePalette } from '../theme'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { Timeline } from './Timeline'

export function ChatScreen({ sessionId, compact, onBack, onOptions, onSearch, onToggleInspector, onReview }: { sessionId: string; compact: boolean; onBack: () => void; onOptions: () => void; onSearch: () => void; onToggleInspector: () => void; onReview: (runId: string) => void }) {
  const colors = usePalette()
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = useWindowDimensions()
  const [scrollRequest, setScrollRequest] = useState(0)
  const [keyboardInset, setKeyboardInset] = useState(0)
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillChangeFrame' : 'keyboardDidShow', (event: KeyboardEvent) => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardInset(Math.max(0, windowHeight - event.endCoordinates.screenY))
    })
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', (event: KeyboardEvent) => {
      if (Platform.OS === 'ios') Keyboard.scheduleLayoutAnimation(event)
      setKeyboardInset(0)
    })
    return () => { show.remove(); hide.remove() }
  }, [windowHeight])
  return <View style={[styles.root, { backgroundColor: colors.background }]}>
    <ChatHeader sessionId={sessionId} compact={compact} onBack={onBack} onOptions={onOptions} onSearch={onSearch} onToggleInspector={onToggleInspector} />
    <View style={[styles.body, { paddingBottom: keyboardInset }]}>
      <Timeline sessionId={sessionId} scrollRequest={scrollRequest} onReview={onReview} />
      <View style={{ paddingBottom: keyboardInset > 0 ? 0 : insets.bottom }}>
        <Composer sessionId={sessionId} onSent={() => setScrollRequest(value => value + 1)} />
      </View>
    </View>
  </View>
}
const styles = StyleSheet.create({ root: { flex: 1, minWidth: 0 }, body: { flex: 1, minHeight: 0 } })
