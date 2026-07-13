import { useState } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet } from 'react-native'
import { usePalette } from '../theme'
import { ChatHeader } from './ChatHeader'
import { Composer } from './Composer'
import { Timeline } from './Timeline'

export function ChatScreen({ sessionId, compact, onBack, onOptions, onSearch, onToggleInspector, onReview }: { sessionId: string; compact: boolean; onBack: () => void; onOptions: () => void; onSearch: () => void; onToggleInspector: () => void; onReview: (runId: string) => void }) {
  const colors = usePalette()
  const [scrollRequest, setScrollRequest] = useState(0)
  return <KeyboardAvoidingView
    behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    keyboardVerticalOffset={0}
    style={[styles.root, { backgroundColor: colors.background }]}
  >
    <ChatHeader sessionId={sessionId} compact={compact} onBack={onBack} onOptions={onOptions} onSearch={onSearch} onToggleInspector={onToggleInspector} />
    <Timeline sessionId={sessionId} scrollRequest={scrollRequest} onReview={onReview} />
    <Composer sessionId={sessionId} onSent={() => setScrollRequest(value => value + 1)} />
  </KeyboardAvoidingView>
}
const styles = StyleSheet.create({ root: { flex: 1, minWidth: 0 } })
