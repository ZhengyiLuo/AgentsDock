import { useMemo } from 'react'
import { Pressable, StyleSheet, useColorScheme, View } from 'react-native'
import { useRecyclingState } from '@shopify/flash-list'
import { ChevronDown, ChevronRight, MessageSquareShare } from 'lucide-react-native'
import type { SystemRow } from '../lib/timeline'
import { foldMarkdownSource } from '../lib/math'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { MarkdownContent } from './MarkdownContent'
import {
  CROSS_CHAT_CONVERSATION_DARK,
  CROSS_CHAT_CONVERSATION_LIGHT,
  CrossChatMessageSurface,
  crossChatCollapsedText,
} from './CrossChatTimelineCards'

const PREVIEW_CHARACTERS = 3_200
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Sender labels never grant routes; only an authenticated participant ID can navigate. */
export function ImportedCrossChatDeliveryCard({ row, fontScale, layoutWidth }: { row: SystemRow; fontScale: number; layoutWidth?: number }) {
  const colors = usePalette()
  const light = useColorScheme() === 'light'
  const palette = light ? CROSS_CHAT_CONVERSATION_LIGHT : CROSS_CHAT_CONVERSATION_DARK
  const delivery = row.importedDelivery
  const [sourceOpen, setSourceOpen] = useRecyclingState(false, [row.key, row.event.id])
  if (!delivery) return null
  const date = new Date(row.event.ts)
  const time = Number.isFinite(date.getTime()) ? timeFormatter.format(date) : ''
  const identity = `imported-cross-chat-${row.event.id}`

  if (delivery.kind === 'status') return <View testID={`${identity}-status`} style={[styles.status, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <MessageSquareShare size={14} color={colors.muted} />
    <View style={styles.content}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={[styles.statusTitle, { color: colors.text }]}>Status update</Text>
        {time ? <Text style={[styles.time, { color: colors.muted }]}>{time}</Text> : null}
      </View>
      <DeliveryMarkdown identity={`${identity}-body`} value={delivery.body} fontScale={fontScale} color={colors.text} controlColor={colors.blue} />
    </View>
  </View>

  return <CrossChatMessageSurface identity={identity} incoming layoutWidth={layoutWidth}
    sessionId={row.event.session_id} peerId={row.event.source_session_id} title={delivery.sender} time={time}>
    {delivery.editedByUser ? <Text style={[styles.time, { color: colors.muted }]}>Edited by you</Text> : null}
    <DeliveryMarkdown identity={`${identity}-body`} value={delivery.body} fontScale={fontScale} color={colors.text} controlColor={palette.toggle} message />
    {delivery.sourceRequest ? <View style={styles.source}>
      <Pressable
        testID={`${identity}-source-toggle`}
        accessibilityRole="button"
        accessibilityLabel={sourceOpen ? 'Hide source request' : 'Show source request'}
        accessibilityState={{ expanded: sourceOpen }}
        onPress={() => setSourceOpen(value => !value)}
        style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.7 : 1 }]}
      >
        {sourceOpen ? <ChevronDown size={13} color={palette.toggle} /> : <ChevronRight size={13} color={palette.toggle} />}
        <Text style={[styles.toggleLabel, { color: palette.toggle }]}>Source request</Text>
      </Pressable>
      {sourceOpen ? <View testID={`${identity}-source`}>
        <DeliveryMarkdown identity={`${identity}-source-body`} value={delivery.sourceRequest} fontScale={fontScale} color={colors.text} controlColor={palette.toggle} />
      </View> : null}
    </View> : null}
  </CrossChatMessageSurface>
}

function DeliveryMarkdown({ identity, value, fontScale, color, controlColor, message = false }: {
  identity: string; value: string; fontScale: number; color: string; controlColor: string; message?: boolean
}) {
  const fold = useMemo(() => foldMarkdownSource(value, PREVIEW_CHARACTERS), [value])
  const preview = message ? crossChatCollapsedText(value) : fold.folded ? `${fold.visible.trimEnd()}\n\n…` : value
  const folded = preview !== value
  const [expanded, setExpanded] = useRecyclingState(false, [identity, value])
  return <View testID={identity} style={styles.markdown}>
    <MarkdownContent value={folded && !expanded ? preview : value} fontScale={fontScale} compact color={color} />
    {folded ? <Pressable
      testID={`${identity}-toggle`}
      accessibilityRole="button"
      accessibilityLabel={expanded ? 'Show less of message' : 'Show full message'}
      accessibilityState={{ expanded }}
      onPress={() => setExpanded(current => !current)}
      style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.7 : 1 }]}
    ><Text style={[styles.toggleLabel, { color: controlColor }]}>{expanded ? 'Show less' : message ? 'View message' : 'Show more'}</Text></Pressable> : null}
  </View>
}

const styles = StyleSheet.create({
  content: { flex: 1, minWidth: 0 },
  header: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  time: { flexShrink: 0, fontSize: 9, lineHeight: 13, fontVariant: ['tabular-nums'] },
  markdown: { minWidth: 0, maxWidth: '100%' },
  source: { minWidth: 0, marginTop: 2 },
  toggle: { minHeight: 44, minWidth: 44, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5 },
  toggleLabel: { minWidth: 0, flexShrink: 1, fontSize: 10.5, lineHeight: 15, fontWeight: '700' },
  status: { marginHorizontal: 14, marginVertical: 5, padding: 12, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, flexDirection: 'row', alignItems: 'flex-start' },
  statusTitle: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, fontWeight: '700' },
})
