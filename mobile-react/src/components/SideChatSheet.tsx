import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Alert, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { KeyboardAvoidingView } from 'react-native-keyboard-controller'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ChevronDown, ChevronRight, RefreshCw, Send, Square, Trash2 } from 'lucide-react-native'
import { useSideChat } from '../hooks/useSideChat'
import { t } from '../i18n'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { sideQuestionLimit, type SyncedSideChat } from '../lib/side-chat'
import { useAppStore } from '../store/useAppStore'
import { fontWeight, radius, spacing, typography, usePalette } from '../theme'
import { Text, TextInput } from './AppText'
import { MarkdownContent } from './MarkdownContent'
import { IconButton, SheetCloseButton } from './ui'

type SideChatState = ReturnType<typeof useSideChat>
type Exchange = SyncedSideChat['exchanges'][number]
type Activity = NonNullable<Exchange['activity']>[number]

/** Mounted only while open: closing releases the subscription, not the reply. */
export function SideChatSheet({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const state = useSideChat(sessionId, true)
  const title = useAppStore(store => store.sessions.find(session => session.id === sessionId)?.title ?? '')
  const fontScale = useAppStore(store => store.fontScale)
  const health = useAppStore(store => store.health)
  return <SideChatSheetView state={state} title={title} fontScale={fontScale} questionLimit={sideQuestionLimit(health)} onClose={onClose} />
}

/** Presentation boundary; the hook owns all authenticated requests and scope checks. */
export function SideChatSheetView({ state, title, fontScale, questionLimit, onClose }: {
  state: SideChatState
  title: string
  fontScale: number
  questionLimit: number
  onClose: () => void
}) {
  const colors = usePalette()
  const [draft, setDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const input = useRef<TextInput>(null)
  const scroll = useRef<ScrollView>(null)
  const nearBottom = useRef(true)
  const mounted = useRef(true)
  const sending = useRef(false)
  const confirmingClear = useRef(false)
  const closing = useRef(false)
  const currentState = useRef(state)
  currentState.current = state
  const exchanges = state.snapshot?.exchanges ?? []
  const running = exchanges.find(exchange => exchange.status === 'running')
  const question = draft.trim()
  const tooLong = Array.from(question).length > questionLimit
  const busy = state.mutating || submitting
  const canSend = state.supported && state.available && state.snapshot !== null && !state.loading && !busy && !running && Boolean(question) && !tooLong
  const canClear = state.available && !state.loading && !busy && !running && exchanges.length > 0
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const close = () => {
    if (!mounted.current || closing.current) return
    closing.current = true
    // Release this sheet's responder while it is still mounted. A deferred
    // global dismissal can otherwise blur the main composer after it refocuses.
    input.current?.blur()
    dismissAppKeyboard()
    onClose()
  }
  const send = async () => {
    if (!canSend || sending.current) return
    sending.current = true
    setSubmitting(true)
    try {
      const accepted = await state.submit(question)
      if (mounted.current && accepted) {
        // The server accepting a request is not the same as finishing a reply.
        // Do not erase a newer draft while the first request is in flight.
        setDraft(value => value.trim() === question ? '' : value)
        nearBottom.current = true
      }
    } finally {
      sending.current = false
      if (mounted.current) setSubmitting(false)
    }
  }
  const confirmClear = () => {
    if (!canClear || confirmingClear.current) return
    confirmingClear.current = true
    const sideChatId = state.snapshot?.side_chat_id
    const revision = state.snapshot?.revision
    const dismiss = () => { confirmingClear.current = false }
    Alert.alert(t('Clear side chat?'), t('This removes this side conversation from all connected devices. The main chat is unchanged.'), [
      { text: t('Cancel'), style: 'cancel', onPress: dismiss },
      { text: t('Clear side chat'), style: 'destructive', onPress: () => {
        if (!confirmingClear.current) return
        dismiss()
        const latest = currentState.current
        if (!mounted.current || !latest.available || latest.loading || latest.mutating || !latest.snapshot
          || latest.snapshot?.side_chat_id !== sideChatId
          || latest.snapshot?.exchanges.some(exchange => exchange.status === 'running')) return
        if (latest.snapshot.revision !== revision) {
          Alert.alert(t('Side chat changed'), t('Review the latest replies before clearing this side chat.'))
          return
        }
        void latest.clear()
      } },
    ], { cancelable: true, onDismiss: dismiss })
  }

  return <Modal visible animationType="slide" presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'} allowSwipeDismissal onRequestClose={close}>
    <SafeAreaView testID="side-chat-sheet" accessibilityViewIsModal onAccessibilityEscape={close} style={[styles.sheet, { backgroundColor: colors.background }]} edges={['top', 'bottom']}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <View style={styles.headerCopy}>
          <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]} localize>Side chat</Text>
          <Text numberOfLines={2} style={[styles.caption, { color: colors.muted }]}>{title}</Text>
        </View>
        <IconButton icon={RefreshCw} label="Refresh side chat" testID="side-chat-refresh" disabled={!state.available || state.loading || busy} onPress={() => { void state.refresh() }} />
        <IconButton icon={Trash2} label="Clear side chat" testID="side-chat-clear" disabled={!canClear} onPress={confirmClear} />
        <SheetCloseButton label="Close side chat" testID="side-chat-close" onPress={close} />
      </View>
      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} automaticOffset>
        <ScrollView ref={scroll} testID="side-chat-scroll" style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive"
          scrollEventThrottle={100}
          onScroll={event => { const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent; nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 80 }}
          onContentSizeChange={() => { if (nearBottom.current) scroll.current?.scrollToEnd({ animated: false }) }}>
          <Text style={[styles.bodyText, { color: colors.muted }]} localize>Ask using this chat's native context without interrupting the main reply.</Text>
          <Text style={[styles.caption, { color: colors.muted }]} localize>Side replies may use tools in the same workspace.</Text>
          {state.offline ? <Text testID="side-chat-offline" accessibilityLiveRegion="polite" style={[styles.bodyText, { color: colors.orange }]} localize>Reconnect to this server to use side chat. Saved replies reload when connected.</Text>
            : !state.supported ? <Text testID="side-chat-unsupported" style={[styles.bodyText, { color: colors.orange }]} localize>Side chat requires a supported Codex or Claude chat and an updated AgentsServer.</Text> : null}
          {state.loading ? <View testID="side-chat-loading" style={styles.status}><ActivityIndicator color={colors.blue} /><Text style={[styles.bodyText, { color: colors.muted }]} localize>Loading side chat…</Text></View> : null}
          {state.snapshot?.model ? <Text style={[styles.caption, { color: colors.muted }]}>{state.snapshot.model}{state.snapshot.effort ? ` · ${state.snapshot.effort}` : ''}</Text> : null}
          {!exchanges.length && !state.loading && state.available && state.snapshot ? <Text testID="side-chat-empty" style={[styles.bodyText, { color: colors.muted }]} localize>Ask a question, then continue with follow-ups here. Your main chat stays separate.</Text> : null}
          {exchanges.map(exchange => <View key={exchange.request_id} testID={`side-chat-exchange-${exchange.request_id}`} style={styles.exchange}>
            <View style={[styles.question, { backgroundColor: colors.user }]}><Text selectable style={[styles.bodyText, { color: colors.text }]}>{exchange.question}</Text></View>
            <SideChatResponse exchange={exchange} fontScale={fontScale} />
            {exchange.context_note ? <Text style={[styles.caption, { color: colors.muted }]}>{exchange.context_note}</Text> : null}
            {exchange.status === 'failed' ? <Text accessibilityLiveRegion="polite" style={[styles.bodyText, { color: colors.red }]}>{exchange.error || t('Side reply failed. You can send the question again.')}</Text> : null}
            {exchange.status === 'cancelled' || exchange.status === 'interrupted' ? <Text style={[styles.caption, { color: colors.muted }]}>{t(exchange.status === 'cancelled' ? 'Side reply stopped' : 'Side reply interrupted')}</Text> : null}
            {(exchange.status === 'failed' || exchange.status === 'interrupted') && !question ? <Pressable testID={`side-chat-reuse-${exchange.request_id}`} accessibilityRole="button" accessibilityState={{ disabled: !state.available || busy }} disabled={!state.available || busy} onPress={() => setDraft(exchange.question)} style={styles.retry}>
              <Text style={[styles.actionText, { color: colors.blue }]} localize>Use question again</Text>
            </Pressable> : null}
          </View>)}
          {state.error ? <View testID="side-chat-error" accessibilityLiveRegion="polite" style={[styles.notice, { borderColor: colors.border }]}>
            <Text style={[styles.bodyText, { color: colors.red }]}>{state.error}</Text>
            <Pressable testID="side-chat-retry" accessibilityRole="button" accessibilityState={{ disabled: !state.available || state.loading || busy }} disabled={!state.available || state.loading || busy} onPress={() => { void state.refresh() }} style={styles.retry}>
              <Text style={[styles.actionText, { color: colors.blue }]} localize>Reload side chat</Text>
            </Pressable>
            <Text style={[styles.caption, { color: colors.muted }]} localize>Reload checks the server; it does not resend your question.</Text>
          </View> : null}
        </ScrollView>
        <View style={[styles.composer, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          {running ? <View style={styles.runningRow}>
            <Text style={[styles.caption, styles.flexible, { color: colors.muted }]} localize>The main chat keeps running. Closing this sheet does not stop the side reply.</Text>
            <Pressable testID="side-chat-stop" accessibilityRole="button" accessibilityLabel={t('Stop side reply')} accessibilityState={{ disabled: !state.available || busy }} disabled={!state.available || busy} onPress={() => { void state.stop(running.request_id) }} style={({ pressed }) => [styles.stop, { borderColor: colors.controlBorder, opacity: !state.available || busy ? 0.35 : pressed ? 0.65 : 1 }]}>
              <Square size={14} color={colors.text} /><Text style={[styles.actionText, { color: colors.text }]} localize>Stop side reply</Text>
            </Pressable>
          </View> : null}
          <TextInput ref={input} testID="side-chat-question" accessibilityLabel="Side chat question" placeholder={exchanges.length ? 'Ask a follow-up…' : 'Ask about this chat…'} value={draft} onChangeText={setDraft} multiline scrollEnabled
            editable={state.supported && state.available} textAlignVertical="top" style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]} placeholderTextColor={colors.muted} />
          {tooLong ? <Text testID="side-chat-limit" style={[styles.caption, { color: colors.red }]}>{t('Side questions are limited to {limit} characters.', { limit: questionLimit })}</Text> : null}
          <View style={styles.sendRow}>
            <Text style={[styles.caption, styles.flexible, { color: colors.muted }]} localize>Replies are saved with this chat on the server.</Text>
            <Pressable testID="side-chat-send" accessibilityRole="button" accessibilityLabel={t('Send side question')} accessibilityState={{ disabled: !canSend, busy: submitting }} disabled={!canSend} onPress={() => { void send() }} style={({ pressed }) => [styles.send, { backgroundColor: colors.blue, opacity: !canSend ? 0.35 : pressed ? 0.65 : 1 }]}>
              {submitting ? <ActivityIndicator size="small" color={colors.onAccent} /> : <Send size={16} color={colors.onAccent} />}
              <Text style={[styles.actionText, { color: colors.onAccent }]} localize>Send</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>
}

function ActivityGroup({ items, live, fontScale }: { items: Activity[]; live: boolean; fontScale: number }) {
  const colors = usePalette()
  const [expanded, setExpanded] = useState(false)
  const latest = items.at(-1)
  const label = live && latest?.kind === 'tool' ? 'Using tools' : live ? 'Thinking' : 'Activity details'
  return <View>
    <Pressable testID={`side-chat-activity-${items[0].id}`} accessibilityRole="button" accessibilityLabel={t('Side reply activity')} accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.activityToggle}>
      {live ? <ActivityIndicator size="small" color={colors.muted} /> : expanded ? <ChevronDown size={16} color={colors.muted} /> : <ChevronRight size={16} color={colors.muted} />}
      <Text style={[styles.caption, { color: colors.muted }]}>{t(label)}</Text>
    </Pressable>
    {expanded ? items.map(item => <View key={item.id} style={[styles.activity, { borderLeftColor: colors.border }]}>
      <Text style={[styles.caption, { color: colors.muted }]}>{t(item.kind === 'tool' ? 'Tool activity' : item.kind === 'reasoning' ? 'Reasoning trace' : 'Thinking summary')}</Text>
      {item.kind === 'tool' ? <Text selectable style={[styles.bodyText, { color: colors.text }]}>{item.text}</Text> : <MarkdownContent value={item.text} fontScale={fontScale} />}
    </View>) : null}
  </View>
}

function SideChatResponse({ exchange, fontScale }: { exchange: Exchange; fontScale: number }) {
  const colors = usePalette()
  const live = exchange.status === 'running'
  const activity = exchange.activity ?? []
  const streamedAnswer = activity.filter(item => item.kind === 'answer').map(item => item.text).join('\n\n').trim()
  const finalOverride = exchange.status === 'completed' && exchange.answer && exchange.answer.trim() !== streamedAnswer
  const items = finalOverride ? activity.filter(item => item.kind !== 'answer') : activity
  const groups: Array<{ id: string; activity: Activity[] } | { id: string; message: Activity }> = []
  for (const item of items) {
    if (item.kind === 'answer' || item.kind === 'commentary') {
      if (item.text) groups.push({ id: item.id, message: item })
    } else {
      const tail = groups.at(-1)
      if (tail && 'activity' in tail) tail.activity.push(item)
      else groups.push({ id: item.id, activity: [item] })
    }
  }
  const hasStreamedAnswer = items.some(item => item.kind === 'answer' && item.text)
  return <View style={styles.response}>
    {groups.map((group, index) => 'message' in group
      ? <MarkdownContent key={group.id} value={group.message.text} fontScale={fontScale} />
      : <ActivityGroup key={group.id} items={group.activity} live={live && index === groups.length - 1} fontScale={fontScale} />)}
    {exchange.answer && !hasStreamedAnswer ? <MarkdownContent value={exchange.answer} fontScale={fontScale} /> : null}
    {live ? <View style={styles.status} accessibilityLiveRegion="polite"><ActivityIndicator size="small" color={colors.blue} /><Text style={[styles.caption, { color: colors.muted }]} localize>Side reply running…</Text></View> : null}
  </View>
}

const styles = StyleSheet.create({
  sheet: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.md, paddingTop: spacing.lg, paddingBottom: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth },
  headerCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  title: { ...typography.title, fontWeight: fontWeight.semibold },
  body: { flex: 1, minHeight: 0 },
  scroll: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.sm, width: '100%', maxWidth: 760, alignSelf: 'center' },
  bodyText: { ...typography.body },
  caption: { ...typography.caption },
  actionText: { ...typography.label, fontWeight: fontWeight.semibold },
  exchange: { gap: spacing.sm, paddingVertical: spacing.sm },
  question: { borderRadius: radius.md, padding: spacing.md, alignSelf: 'stretch' },
  response: { gap: spacing.sm },
  status: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 32 },
  notice: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  retry: { minHeight: 44, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: spacing.sm },
  composer: { flexShrink: 0, padding: spacing.md, gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth },
  runningRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  flexible: { flex: 1, minWidth: 120 },
  input: { ...typography.body, minHeight: 48, maxHeight: 144, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  sendRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  send: { minHeight: 44, minWidth: 88, paddingHorizontal: spacing.lg, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  stop: { minHeight: 44, paddingHorizontal: spacing.md, borderWidth: 1, borderRadius: radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  activityToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  activity: { paddingLeft: spacing.md, paddingVertical: spacing.xs, borderLeftWidth: 2, gap: spacing.xs },
})
