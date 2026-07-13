import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NativeScrollEvent, NativeSyntheticEvent, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { FlashList, type FlashListRef } from '@shopify/flash-list'
import { ArrowDown, ArrowUp } from 'lucide-react-native'
import { projectTimeline, type TimelineRow } from '../lib/timeline'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Loading } from './ui'
import { TimelineRowView } from './TimelineRows'

export function Timeline({ sessionId, scrollRequest, onReview }: { sessionId: string; scrollRequest: number; onReview: (runId: string) => void }) {
  const colors = usePalette()
  const snapshot = useAppStore(state => state.snapshots[sessionId])
  const loading = useAppStore(state => state.loadingSessionId === sessionId)
  const loadingOlder = useAppStore(state => state.loadingOlder)
  const loadOlder = useAppStore(state => state.loadOlder)
  const fontScale = useAppStore(state => state.fontScale)
  const list = useRef<FlashListRef<TimelineRow>>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const nearBottomRef = useRef(true)
  const [viewportWidth, setViewportWidth] = useState(0)
  const rows = useMemo(() => projectTimeline(snapshot?.events ?? [], snapshot?.files ?? []), [snapshot?.events, snapshot?.files])
  const lastSession = useRef(sessionId)

  useEffect(() => {
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId
      setNearBottom(true)
    }
  }, [sessionId])
  useEffect(() => {
    if (!scrollRequest || !rows.length) return
    requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }))
  }, [rows.length, scrollRequest])
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    if (!width || Math.abs(width - viewportWidth) < 2) return
    setViewportWidth(width)
    requestAnimationFrame(() => {
      list.current?.recomputeViewableItems()
      if (nearBottomRef.current) list.current?.scrollToEnd({ animated: false })
    })
  }, [viewportWidth])

  if (!snapshot && loading) return <Loading label="Loading latest messages" />
  return (
    <View style={styles.root} onLayout={handleLayout}>
      <FlashList
        ref={list}
        data={rows}
        keyExtractor={row => row.key}
        getItemType={row => row.kind}
        renderItem={({ item }) => <TimelineRowView row={item} sessionId={sessionId} onReview={onReview} fontScale={fontScale} layoutWidth={viewportWidth} />}
        extraData={`${fontScale}:${viewportWidth}`}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={styles.content}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: -1 }}
        drawDistance={700}
        onStartReached={() => { if (snapshot?.hasMore && !loadingOlder) void loadOlder(sessionId) }}
        onStartReachedThreshold={0.35}
        onScroll={event => {
          const next = distanceFromBottom(event) < 120
          nearBottomRef.current = next
          setNearBottom(current => current === next ? current : next)
        }}
        scrollEventThrottle={80}
        removeClippedSubviews={false}
        ListHeaderComponent={snapshot?.hasMore ? <Pressable onPress={() => void loadOlder(sessionId)} style={[styles.older, { borderColor: colors.border, backgroundColor: colors.surface }]}>{loadingOlder ? <Text style={{ color: colors.muted }}>Loading…</Text> : <><ArrowUp size={14} color={colors.muted} /><Text style={{ color: colors.muted, fontSize: 12 }}>Load older messages</Text></>}</Pressable> : null}
        ListEmptyComponent={<View style={styles.empty}><Text style={{ color: colors.muted }}>No messages yet.</Text></View>}
      />
      {!nearBottom && rows.length ? <Pressable onPress={() => list.current?.scrollToEnd({ animated: true })} style={[styles.bottom, { backgroundColor: colors.raised, borderColor: colors.border }]}><ArrowDown size={17} color={colors.text} /></Pressable> : null}
    </View>
  )
}

function distanceFromBottom(event: NativeSyntheticEvent<NativeScrollEvent>): number {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y)
}
function Separator() { return <View style={{ height: 10 }} /> }
const styles = StyleSheet.create({
  root: { flex: 1 }, content: { paddingTop: 12, paddingBottom: 18 },
  older: { minHeight: 38, marginHorizontal: 14, marginBottom: 10, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  empty: { minHeight: 220, alignItems: 'center', justifyContent: 'center' },
  bottom: { position: 'absolute', right: 17, bottom: 12, width: 36, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
})
