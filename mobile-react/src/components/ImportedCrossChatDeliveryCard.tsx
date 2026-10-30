import { StyleSheet, View } from 'react-native'
import { useRecyclingState } from '@shopify/flash-list'
import { MessageSquareShare } from 'lucide-react-native'
import type { SystemRow } from '../lib/timeline'
import { radius, typography, usePalette } from '../theme'
import { Text } from './AppText'
import {
  CrossChatAction,
  crossChatCollapsedText,
  CrossChatMessageSurface,
  CrossChatMessageText,
  CrossChatPeerHeader,
  formatCrossChatTime,
} from './CrossChatTimelineCards'

/** Imported wrappers supply display content, never routes inferred from sender names. */
export function ImportedCrossChatDeliveryCard({ row, sessionId, fontScale, layoutWidth }: {
  row: SystemRow; sessionId: string; fontScale: number; layoutWidth: number
}) {
  const colors = usePalette()
  const [expanded, setExpanded] = useRecyclingState(false, [row.key, row.event.id])
  const delivery = row.importedDelivery
  if (!delivery) return null
  const time = formatCrossChatTime(row.event.ts)
  const identity = `imported-cross-chat-${row.event.id}`
  const collapsed = crossChatCollapsedText(delivery.body)
  const long = collapsed !== delivery.body
  if (delivery.kind === 'status') return <View testID={`${identity}-status`} style={[styles.status, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <MessageSquareShare size={14} color={colors.muted} />
    <View style={styles.content}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]} localize>Status update</Text>
        {time ? <Text style={[styles.time, { color: colors.muted }]}>{time}</Text> : null}
      </View>
      <CrossChatMessageText identity={`${identity}-body`} text={delivery.body} fontScale={fontScale} />
    </View>
  </View>
  return <CrossChatMessageSurface testID={identity} incoming layoutWidth={layoutWidth}>
    <CrossChatPeerHeader peerId={row.event.source_session_id} title={delivery.sender} sessionId={sessionId} time={time} />
    {delivery.editedByUser ? <Text style={[typography.caption, { color: colors.muted }]} localize>Edited by you</Text> : null}
    <CrossChatMessageText identity={`${identity}-body`} text={expanded || !long ? delivery.body : collapsed} fontScale={fontScale} />
    {long ? <CrossChatAction testID={`${identity}-body-toggle`} label={expanded ? 'Show less' : 'View message'} expanded={expanded} onPress={() => setExpanded(value => !value)} /> : null}
  </CrossChatMessageSurface>
}

const styles = StyleSheet.create({
  content: { flex: 1, minWidth: 0 },
  header: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  title: { flex: 1, minWidth: 0, ...typography.label },
  time: { flexShrink: 0, ...typography.caption, fontVariant: ['tabular-nums'] },
  status: { marginHorizontal: 14, marginVertical: 5, padding: 12, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, flexDirection: 'row', alignItems: 'flex-start' },
})
