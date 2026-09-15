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
  CrossChatConversationSurface,
  CrossChatPeerHeading,
} from './CrossChatTimelineCards'

const PREVIEW_CHARACTERS = 3_200
const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

/** Sender labels never grant routes; only an authenticated participant ID can navigate. */
export function ImportedCrossChatDeliveryCard({ row, fontScale }: { row: SystemRow; fontScale: number }) {
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

  return <CrossChatConversationSurface testID={identity} palette={palette}>
    <View style={styles.header}>
      <Text accessibilityRole="header" style={[styles.eyebrow, { color: palette.eyebrow }]}>Agent conversation</Text>
      {time ? <Text style={[styles.time, { color: palette.participants }]}>{time}</Text> : null}
    </View>
    <View testID={`${identity}-message`} accessibilityLabel={`Imported message from ${delivery.sender}`} style={[
      styles.incoming,
      {
        backgroundColor: palette.incomingBackground,
        borderColor: palette.incomingBorder,
        shadowColor: palette.shadow,
        shadowOpacity: light ? 0.09 : 0.18,
        shadowRadius: light ? 9 : 10,
      },
    ]}>
      <CrossChatPeerHeading peerId={row.event.source_session_id} sessionId={row.event.session_id}><Text testID={`${identity}-sender`} style={[styles.speaker, { color: palette.speaker }]}>{delivery.sender}</Text></CrossChatPeerHeading>
      <DeliveryMarkdown identity={`${identity}-body`} value={delivery.body} fontScale={fontScale} color={palette.body} controlColor={palette.toggle} />
    </View>
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
        <DeliveryMarkdown identity={`${identity}-source-body`} value={delivery.sourceRequest} fontScale={fontScale} color={palette.body} controlColor={palette.toggle} />
      </View> : null}
    </View> : null}
  </CrossChatConversationSurface>
}

function DeliveryMarkdown({ identity, value, fontScale, color, controlColor }: {
  identity: string; value: string; fontScale: number; color: string; controlColor: string
}) {
  const fold = useMemo(() => foldMarkdownSource(value, PREVIEW_CHARACTERS), [value])
  const [expanded, setExpanded] = useRecyclingState(false, [identity, value])
  return <View testID={identity} style={styles.markdown}>
    <MarkdownContent value={fold.folded && !expanded ? `${fold.visible.trimEnd()}\n\n…` : value} fontScale={fontScale} compact color={color} />
    {fold.folded ? <Pressable
      testID={`${identity}-toggle`}
      accessibilityRole="button"
      accessibilityLabel={expanded ? 'Show less of message' : 'Show full message'}
      accessibilityState={{ expanded }}
      onPress={() => setExpanded(current => !current)}
      style={({ pressed }) => [styles.toggle, { opacity: pressed ? 0.7 : 1 }]}
    ><Text style={[styles.toggleLabel, { color: controlColor }]}>{expanded ? 'Show less' : 'Show more'}</Text></Pressable> : null}
  </View>
}

const styles = StyleSheet.create({
  content: { flex: 1, minWidth: 0 },
  header: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 5 },
  eyebrow: { flex: 1, minWidth: 0, fontSize: 9, lineHeight: 13, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase' },
  time: { flexShrink: 0, fontSize: 9, lineHeight: 13, fontVariant: ['tabular-nums'] },
  // Keep phone text readable while limiting long lines on an iPad. The inner
  // incoming bubble matches the Mac tint, padding, and asymmetric corners.
  incoming: {
    alignSelf: 'flex-start', width: '100%', maxWidth: 620, minWidth: 0,
    paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1,
    borderRadius: 12, borderBottomLeftRadius: 4,
    shadowOffset: { width: 0, height: 3 },
  },
  speaker: { fontSize: 10.5, lineHeight: 15, fontWeight: '800', marginBottom: 4, flexShrink: 1 },
  markdown: { minWidth: 0, maxWidth: '100%' },
  source: { minWidth: 0, marginTop: 2 },
  toggle: { minHeight: 44, minWidth: 44, maxWidth: '100%', flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5 },
  toggleLabel: { minWidth: 0, flexShrink: 1, fontSize: 10.5, lineHeight: 15, fontWeight: '700' },
  status: { marginHorizontal: 14, marginVertical: 5, padding: 12, gap: 8, borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, flexDirection: 'row', alignItems: 'flex-start' },
  statusTitle: { flex: 1, minWidth: 0, fontSize: 12, lineHeight: 17, fontWeight: '700' },
})
