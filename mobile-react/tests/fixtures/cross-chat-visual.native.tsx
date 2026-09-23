import 'react-native-gesture-handler'
import { registerRootComponent } from 'expo'
import { StatusBar } from 'expo-status-bar'
import { Dimensions, ScrollView, StyleSheet, View } from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { AppTypographyProvider, Text } from '../../src/components/AppText'
import { TimelineRowView } from '../../src/components/TimelineRows'
import { projectTimeline } from '../../src/lib/timeline'
import { sanitizeTimelineEvent } from '../../src/lib/timeline-memory'
import { useAppStore } from '../../src/store/useAppStore'
import { usePalette } from '../../src/theme'
import type { Event } from '../../src/types'

// This isolated native entry never initializes the app or connects to servers.
// Its larger source block exercises sanitizing before the 48k prompt boundary.
globalThis.fetch = async () => { throw new Error('Network disabled in visual fixture') }
const width = Dimensions.get('window').width
const fontScale = width < 390 ? 1.4 : 1
useAppStore.setState({ fontScale })
const sessionId = 'visual-fixture'
const source = 'SOURCE FIXTURE — THIS TEXT MUST STAY COLLAPSED. ' + 'Source instruction. '.repeat(3_500)
const reply = '[AgentsDock delivery kind=reply leg=2/2 origin=route from=AgentsDock Sept]\n'
  + `[Source user instruction — verbatim, user-authored]\n${source}\n[End source user instruction]\n`
  + '[Agent-prepared reply/result]\n**Ready.** The reply uses the purple message bubble.\n\nInline `code` and $x^2$ stay readable.\n[End agent-prepared reply/result]\n'
  + 'reply: use Chats respond-current through the AgentsDock provider tool only if a reply or follow-up is needed.\n[End delivery]'
const status = '[AgentsDock delivery kind=status leg=0/2 origin=route from=AgentsDock Sept]\n'
  + '[Source user instruction — verbatim, user-authored]\nHIDDEN STATUS SOURCE\n[End source user instruction]\n'
  + '[Server-generated exchange status]\nThe conversation ended before delivery.\n[End server-generated exchange status]\n'
  + 'reply: none (terminal status notice; do not respond to the exchange)\n[End delivery]'
const base = { session_id: sessionId, ts: '2026-09-09T19:15:00Z', backend: 'codex' as const, imported: true, run_id: 'import_visual' }
const events: Event[] = [
  { ...base, id: 'visual-reply', seq: 1, type: 'turn_started', prompt: reply },
  { ...base, id: 'visual-answer', seq: 2, type: 'assistant_text', text: 'The next assistant answer stays separate.' },
  { ...base, id: 'visual-finished', seq: 3, type: 'turn_finished' },
  { ...base, id: 'visual-status', seq: 4, type: 'turn_started', prompt: status },
]
const rows = projectTimeline(events.map(sanitizeTimelineEvent), [])
if (rows.length !== 3 || rows[0].kind !== 'system' || !rows[0].importedDelivery || rows[1].kind !== 'message' || rows[2].kind !== 'system' || rows[2].importedDelivery?.kind !== 'status') {
  throw new Error('Visual fixture did not project the expected imported conversation')
}
// Complete local messages exercise direction, intrinsic sizing, and long-body
// expansion without granting routes or making any network request.
rows.push(...projectTimeline([
  { ...base, imported: false, id: 'outgoing-async', seq: 10, type: 'chat_conversation_message_delivered',
    conversation_mode: 'async_route_v1', conversation_id: 'visual-conversation', message_id: 'visual-message',
    cross_chat_envelope_id: 'visual-message', handoff_id: 'visual-message', handoff_status: 'delivered',
    source_session_id: sessionId, target_session_id: 'visual-peer', target_title: 'Other agent', handoff_preview: 'Short outgoing message.' },
  { ...base, imported: false, id: 'incoming-handoff', seq: 11, type: 'cross_chat_handoff_delivered',
    handoff_id: 'visual-handoff', handoff_status: 'delivered', source_session_id: 'visual-peer', target_session_id: sessionId,
    source_title: 'Other agent with a long title that must fit a narrow screen',
    handoff_preview: 'A legacy handoff now shows its **message** immediately.' },
  { ...base, imported: false, id: 'incoming-exchange', seq: 12, type: 'cross_chat_exchange_leg_delivered',
    exchange_id: 'visual-exchange', exchange_status: 'completed', requester_session_id: 'visual-peer', responder_session_id: sessionId,
    source_session_id: 'visual-peer', target_session_id: sessionId, source_title: 'Other agent',
    exchange_leg_id: 'visual-leg', exchange_leg_kind: 'request', exchange_leg_status: 'delivered', exchange_ordinal: 1,
    handoff_preview: '**Long exchange message.**\n\n' + 'Folded message content stays readable. '.repeat(70), handoff_body_truncated: false },
], []))

function Fixture() {
  const colors = usePalette()
  return <AppTypographyProvider>
    <SafeAreaProvider>
      <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={[styles.screen, { backgroundColor: colors.background }]}>
        <View style={[styles.heading, { borderBottomColor: colors.border }]}>
          <Text style={[styles.title, { color: colors.text }]}>Cross-chat rendering</Text>
          <Text style={[styles.detail, { color: colors.muted }]}>{width} pt · font {fontScale.toFixed(1)} · native fixture</Text>
        </View>
        <ScrollView contentContainerStyle={styles.timeline}>
          {rows.map(row => <TimelineRowView key={row.key} row={row} sessionId={sessionId} onReview={() => {}} fontScale={fontScale} layoutWidth={width} />)}
        </ScrollView>
        <StatusBar style="auto" />
      </SafeAreaView>
    </SafeAreaProvider>
  </AppTypographyProvider>
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  heading: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
  detail: { fontSize: 10, lineHeight: 14, marginTop: 2 },
  timeline: { paddingVertical: 8 },
})

registerRootComponent(Fixture)
