import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, NativeScrollEvent, NativeSyntheticEvent, Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { FlashList, type FlashListRef } from '@shopify/flash-list'
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react-native'
import { projectTimeline, type TimelineRow } from '../lib/timeline'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Loading } from './ui'
import { TimelineRowView } from './TimelineRows'

export function Timeline({ sessionId, scrollRequest, keyboardVisible, bottomInset, onReview }: { sessionId: string; scrollRequest: number; keyboardVisible: boolean; bottomInset: number; onReview: (runId: string) => void }) {
  const colors = usePalette()
  const snapshot = useAppStore(state => state.snapshots[sessionId])
  const loading = useAppStore(state => state.loadingSessionId === sessionId)
  const loadingOlder = useAppStore(state => Boolean(state.loadingOlder[sessionId]))
  const loadOlder = useAppStore(state => state.loadOlder)
  const syncSessionId = useAppStore(state => state.syncSessionId)
  const syncStatus = useAppStore(state => state.syncStatus)
  const syncError = useAppStore(state => state.syncError)
  const retryConnection = useAppStore(state => state.retryConnection)
  const fontScale = useAppStore(state => state.fontScale)
  const list = useRef<FlashListRef<TimelineRow>>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const nearBottomRef = useRef(true)
  const [viewportWidth, setViewportWidth] = useState(0)
  const rows = useMemo(() => projectTimeline(snapshot?.events ?? [], snapshot?.files ?? []), [snapshot?.events, snapshot?.files])
  const lastSession = useRef(sessionId)
  const lastKeyboardVisible = useRef(keyboardVisible)
  const keyboardBottomAnchor = useRef(false)

  useLayoutEffect(() => {
    if (lastKeyboardVisible.current === keyboardVisible) return
    lastKeyboardVisible.current = keyboardVisible
    keyboardBottomAnchor.current = nearBottomRef.current
  }, [keyboardVisible])

  useEffect(() => {
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId
      nearBottomRef.current = true
      setNearBottom(true)
    }
  }, [sessionId])
  useEffect(() => {
    if (!scrollRequest || !rows.length) return
    requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }))
  }, [rows.length, scrollRequest])
  useEffect(() => {
    if (!keyboardBottomAnchor.current || !rows.length) return
    keyboardBottomAnchor.current = false
    let secondFrame: number | null = null
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => list.current?.scrollToEnd({ animated: false }))
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame != null) cancelAnimationFrame(secondFrame)
    }
  }, [keyboardVisible])
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    if (!width || Math.abs(width - viewportWidth) < 2) return
    setViewportWidth(width)
    requestAnimationFrame(() => {
      list.current?.recomputeViewableItems()
    })
  }, [viewportWidth])

  const selectedSyncStatus = syncSessionId === sessionId ? syncStatus : 'cached'
  if (!snapshot && (loading || selectedSyncStatus === 'syncing' || selectedSyncStatus === 'reconnecting')) return <Loading label={selectedSyncStatus === 'reconnecting' ? 'Reconnecting to this chat' : 'Loading latest messages'} />
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
        contentContainerStyle={{ paddingTop: 12, paddingBottom: bottomInset + 18 }}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => Keyboard.dismiss()}
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
        ListEmptyComponent={selectedSyncStatus === 'error' || selectedSyncStatus === 'offline'
          ? <View style={styles.empty}>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>Messages unavailable</Text>
            <Text style={[styles.emptyDetail, { color: colors.muted }]} numberOfLines={3}>{syncError || 'The server could not sync this chat.'}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Retry chat sync" onPress={() => void retryConnection()} style={[styles.retry, { backgroundColor: colors.raised, borderColor: colors.border }]}>
              <RefreshCw size={14} color={colors.text} />
              <Text style={{ color: colors.text, fontWeight: '700', fontSize: 12 }}>Retry</Text>
            </Pressable>
          </View>
          : <View style={styles.empty}><Text style={{ color: colors.muted }}>No messages yet.</Text></View>}
      />
      {!nearBottom && rows.length ? <Pressable onPress={() => list.current?.scrollToEnd({ animated: true })} style={[styles.bottom, { bottom: bottomInset + 12, backgroundColor: colors.raised, borderColor: colors.border }]}><ArrowDown size={17} color={colors.text} /></Pressable> : null}
    </View>
  )
}

function distanceFromBottom(event: NativeSyntheticEvent<NativeScrollEvent>): number {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y)
}
function Separator() { return <View style={{ height: 10 }} /> }
const styles = StyleSheet.create({
  root: { flex: 1 },
  older: { minHeight: 38, marginHorizontal: 14, marginBottom: 10, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  empty: { minHeight: 220, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 15, fontWeight: '800', marginBottom: 7 },
  emptyDetail: { fontSize: 12, lineHeight: 17, textAlign: 'center', maxWidth: 360 },
  retry: { marginTop: 14, minHeight: 34, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 7 },
  bottom: { position: 'absolute', right: 17, width: 36, height: 36, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
})
