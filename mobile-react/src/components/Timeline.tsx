import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, NativeScrollEvent, NativeSyntheticEvent, Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { FlashList, type FlashListRef } from '@shopify/flash-list'
import { ArrowDown, ArrowUp, RefreshCw } from 'lucide-react-native'
import { codexLifecycleSemanticKey, isHandoffDigestEvent, isTimelineError, projectPresentableHistory, projectTimeline, type TimelineRow } from '../lib/timeline'
import { shouldFinishTimelineKeyboardDismissal } from '../lib/keyboard-gesture'
import { liveTimelineAdvanced, shouldShowTimelineLatest, timelineMaintainVisiblePosition, timelineTargetRowIndex } from '../lib/timeline-history-navigation'
import { mergeHistoryWithLiveSnapshot } from '../lib/timeline-memory'
import { reuseStableTimelineRows } from '../lib/timeline-row-reuse'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import { Text } from './AppText'
import { Loading } from './ui'
import { TimelineRowView } from './TimelineRows'

const TOP_LOAD_TRIGGER = 140
// FlashList's iOS default is 250. Keeping the default-sized render window
// avoids mounting extra Markdown/UITextView trees during a long fling.
const TIMELINE_DRAW_DISTANCE = 250
// Bound recycled UITextView/Markdown/media trees after a long fling. Row-local
// state uses FlashList's semantic-key-aware recycling hooks.
const MAX_RECYCLED_TIMELINE_ITEMS = 18

export function Timeline({ sessionId, scrollRequest, keyboardVisible, keyboardSettleRequest, bottomInset, onReview }: { sessionId: string; scrollRequest: number; keyboardVisible: boolean; keyboardSettleRequest: number; bottomInset: number; onReview: (runId: string) => void }) {
  const colors = usePalette()
  const liveSnapshot = useAppStore(state => state.snapshots[sessionId])
  const profileGeneration = useAppStore(state => state.profileGeneration)
  const historyWindow = useAppStore(state => state.historyWindow)
  const exitHistory = useAppStore(state => state.exitHistory)
  const matchingHistoryWindow = historyWindow?.profileGeneration === profileGeneration && historyWindow.sessionId === sessionId
    ? historyWindow
    : null
  const projectedHistoryRows = useMemo(
    () => matchingHistoryWindow
      ? projectPresentableHistory(matchingHistoryWindow.snapshot.events, matchingHistoryWindow.snapshot.files)
      : null,
    [matchingHistoryWindow?.snapshot.events, matchingHistoryWindow?.snapshot.files],
  )
  // A compact/failed older-page request can contain transport events without
  // any rows a person can see. Never let that empty window mask a newer live
  // snapshot; the exact failure otherwise looks "Live" while the chat is blank.
  const activeHistoryWindow = matchingHistoryWindow && projectedHistoryRows
    ? matchingHistoryWindow
    : null
  const snapshot = useMemo(
    () => activeHistoryWindow
      ? activeHistoryWindow.detached
        ? activeHistoryWindow.snapshot
        : mergeHistoryWithLiveSnapshot(activeHistoryWindow.snapshot, liveSnapshot)
      : liveSnapshot,
    [activeHistoryWindow, liveSnapshot],
  )
  const loading = useAppStore(state => state.loadingSessionId === sessionId)
  const loadingOlder = useAppStore(state => Boolean(state.loadingOlder[sessionId]))
  const loadOlder = useAppStore(state => state.loadOlder)
  const syncSessionId = useAppStore(state => state.syncSessionId)
  const syncStatus = useAppStore(state => state.syncStatus)
  const syncError = useAppStore(state => state.syncError)
  const retryConnection = useAppStore(state => state.retryConnection)
  const fontScale = useAppStore(state => state.fontScale)
  const canLoadOlder = Boolean(snapshot?.hasMore)
  const list = useRef<FlashListRef<TimelineRow>>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const [searchTargetAlignmentLocked, setSearchTargetAlignmentLocked] = useState(false)
  const nearBottomRef = useRef(true)
  const [viewportWidth, setViewportWidth] = useState(0)
  const stableRows = useRef<TimelineRow[]>([])
  const projectedRows = useMemo(
    () => activeHistoryWindow
      && projectedHistoryRows
      && snapshot?.events === activeHistoryWindow.snapshot.events
      && snapshot?.files === activeHistoryWindow.snapshot.files
      ? projectedHistoryRows
      : projectTimeline(snapshot?.events ?? [], snapshot?.files ?? []),
    [activeHistoryWindow, projectedHistoryRows, snapshot?.events, snapshot?.files],
  )
  const rows = useMemo(() => {
    const next = reuseStableTimelineRows(stableRows.current, projectedRows)
    stableRows.current = next
    return next
  }, [projectedRows])
  const latestLiveSeq = liveSnapshot?.latestSeq ?? liveSnapshot?.events.at(-1)?.seq ?? 0
  const lastSession = useRef(sessionId)
  const lastKeyboardVisible = useRef(keyboardVisible)
  const keyboardBottomAnchor = useRef(false)
  const keyboardAnchorToken = useRef(0)
  const dragStartedWithKeyboard = useRef(false)
  const userScrolling = useRef(false)
  const topLoadArmed = useRef(false)
  const pendingAutomaticOlder = useRef(false)
  const olderRequestInFlight = useRef(false)
  const olderRequestToken = useRef(0)
  const scrollInteractionToken = useRef(0)
  const momentumInteractionToken = useRef<number | null>(null)
  const scrollSettleFrame = useRef<number | null>(null)
  const lastObservedLiveSeq = useRef(latestLiveSeq)
  const consumedSeekRevision = useRef<number | null>(null)
  const seekAlignmentToken = useRef(0)
  const seekAlignmentTimers = useRef<Array<ReturnType<typeof setTimeout>>>([])

  const cancelSeekAlignment = useCallback(() => {
    seekAlignmentToken.current += 1
    for (const timer of seekAlignmentTimers.current) clearTimeout(timer)
    seekAlignmentTimers.current = []
  }, [])

  useLayoutEffect(() => {
    if (lastKeyboardVisible.current === keyboardVisible) return
    lastKeyboardVisible.current = keyboardVisible
    keyboardAnchorToken.current += 1
    keyboardBottomAnchor.current = !userScrolling.current && nearBottomRef.current
  }, [keyboardVisible])

  useEffect(() => {
    if (lastSession.current !== sessionId) {
      lastSession.current = sessionId
      nearBottomRef.current = true
      setNearBottom(true)
      topLoadArmed.current = false
      pendingAutomaticOlder.current = false
      olderRequestToken.current += 1
      olderRequestInFlight.current = false
      scrollInteractionToken.current += 1
      momentumInteractionToken.current = null
      if (scrollSettleFrame.current != null) {
        cancelAnimationFrame(scrollSettleFrame.current)
        scrollSettleFrame.current = null
      }
      keyboardAnchorToken.current += 1
      keyboardBottomAnchor.current = false
      dragStartedWithKeyboard.current = false
      userScrolling.current = false
      lastObservedLiveSeq.current = latestLiveSeq
      consumedSeekRevision.current = null
      cancelSeekAlignment()
      setSearchTargetAlignmentLocked(false)
    }
  }, [cancelSeekAlignment, latestLiveSeq, sessionId])
  useEffect(() => cancelSeekAlignment, [cancelSeekAlignment])
  useEffect(() => {
    // FlashList preserves the viewport while rows above it resize, which is
    // essential for older-page loading. At the live edge we want the inverse:
    // follow new progress/final output, but only while the user is already at
    // the bottom and has not taken control of the scroll.
    const previousLiveSeq = lastObservedLiveSeq.current
    lastObservedLiveSeq.current = latestLiveSeq
    if (
      activeHistoryWindow?.detached
      || loadingOlder
      || olderRequestInFlight.current
      || !liveTimelineAdvanced(previousLiveSeq, latestLiveSeq)
      || !nearBottomRef.current
      || userScrolling.current
    ) return
    const frame = requestAnimationFrame(() => {
      if (
        !loadingOlder
        && !olderRequestInFlight.current
        && nearBottomRef.current
        && !userScrolling.current
      ) {
        list.current?.scrollToEnd({ animated: false })
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [activeHistoryWindow, latestLiveSeq, loadingOlder])
  useEffect(() => {
    if (matchingHistoryWindow && !loadingOlder && !projectedHistoryRows) exitHistory()
  }, [exitHistory, loadingOlder, matchingHistoryWindow, projectedHistoryRows])
  useEffect(() => {
    if (!scrollRequest || !rows.length) return
    requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }))
  }, [rows.length, scrollRequest])
  useEffect(() => {
    if (activeHistoryWindow?.detached) {
      // The search sheet's keyboard can finish hiding after the detached
      // window mounts. Never let that stale composer-bottom anchor overwrite
      // the search-result scrollToIndex.
      keyboardAnchorToken.current += 1
      keyboardBottomAnchor.current = false
      return
    }
    if (!keyboardBottomAnchor.current || !rows.length) return
    const anchorToken = ++keyboardAnchorToken.current
    keyboardBottomAnchor.current = false
    let secondFrame: number | null = null
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (keyboardAnchorToken.current === anchorToken) list.current?.scrollToEnd({ animated: false })
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame != null) cancelAnimationFrame(secondFrame)
    }
  }, [activeHistoryWindow?.detached, keyboardSettleRequest])

  const seekTargetIndex = activeHistoryWindow?.detached && activeHistoryWindow.anchorSeq != null
    ? timelineTargetRowIndex(rows, {
        eventId: activeHistoryWindow.anchorEventId ?? '',
        seq: activeHistoryWindow.anchorSeq,
      })
    : -1
  const alignSeekTarget = useCallback((revision: number, index: number) => {
    cancelSeekAlignment()
    setSearchTargetAlignmentLocked(true)
    const token = seekAlignmentToken.current
    // FlashList lays out in two phases, and native Markdown/UITextView rows can
    // report their final height a little later. Reassert the immutable search
    // target a bounded number of times, stopping immediately when the person
    // starts scrolling or this seek is replaced.
    for (const delay of [0, 140, 420]) {
      const timer = setTimeout(() => {
        if (
          token !== seekAlignmentToken.current
          || userScrolling.current
          || activeHistoryWindow?.anchorRevision !== revision
        ) return
        requestAnimationFrame(() => {
          if (
            token === seekAlignmentToken.current
            && !userScrolling.current
            && activeHistoryWindow?.anchorRevision === revision
          ) list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 })
        })
      }, delay)
      seekAlignmentTimers.current.push(timer)
    }
    const releaseTimer = setTimeout(() => {
      if (token === seekAlignmentToken.current) setSearchTargetAlignmentLocked(false)
    }, 900)
    seekAlignmentTimers.current.push(releaseTimer)
  }, [activeHistoryWindow?.anchorRevision, cancelSeekAlignment])
  useEffect(() => {
    const revision = activeHistoryWindow?.detached ? activeHistoryWindow.anchorRevision : null
    if (revision == null || revision === consumedSeekRevision.current || seekTargetIndex < 0) return
    consumedSeekRevision.current = revision
    alignSeekTarget(revision, seekTargetIndex)
  }, [activeHistoryWindow?.anchorRevision, activeHistoryWindow?.detached, alignSeekTarget, seekTargetIndex])

  const requestOlder = useCallback(async (force = false) => {
    if (!canLoadOlder || loadingOlder || olderRequestInFlight.current || (!force && !topLoadArmed.current)) return
    topLoadArmed.current = false
    olderRequestInFlight.current = true
    const requestToken = ++olderRequestToken.current
    try {
      await loadOlder(sessionId)
    } catch {
      // A new drag or the explicit header button can retry. Keeping this gate
      // closed prevents a failed request from immediately looping in place.
    } finally {
      if (requestToken === olderRequestToken.current) olderRequestInFlight.current = false
    }
  }, [canLoadOlder, loadOlder, loadingOlder, sessionId])

  const scrollToLatest = useCallback(() => {
    scrollInteractionToken.current += 1
    momentumInteractionToken.current = null
    userScrolling.current = false
    if (scrollSettleFrame.current != null) {
      cancelAnimationFrame(scrollSettleFrame.current)
      scrollSettleFrame.current = null
    }
    topLoadArmed.current = false
    pendingAutomaticOlder.current = false
    nearBottomRef.current = true
    setNearBottom(true)
    if (activeHistoryWindow) {
      exitHistory()
      requestAnimationFrame(() => requestAnimationFrame(() => {
        list.current?.scrollToEnd({ animated: false })
      }))
      return
    }
    list.current?.scrollToEnd({ animated: true })
  }, [activeHistoryWindow, exitHistory])
  const finishScrollInteraction = useCallback((interactionToken: number) => {
    if (interactionToken !== scrollInteractionToken.current) return
    momentumInteractionToken.current = null
    userScrolling.current = false
    if (pendingAutomaticOlder.current) {
      pendingAutomaticOlder.current = false
      void requestOlder()
      // A short transcript can be both at the top and "near bottom". Let the
      // native prepend anchor own this interaction instead of scheduling a
      // competing scroll-to-end that can win after the page is published.
      return
    }
    if (!nearBottomRef.current) return
    scrollSettleFrame.current = requestAnimationFrame(() => {
      scrollSettleFrame.current = null
      if (
        interactionToken === scrollInteractionToken.current
        && nearBottomRef.current
        && !userScrolling.current
      ) {
        list.current?.scrollToEnd({ animated: false })
      }
    })
  }, [requestOlder])
  const handleScrollBeginDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Timeline movement must not blur the composer. It also cancels a
    // pending post-keyboard anchor so the user's chosen position wins.
    const offset = Math.max(0, event.nativeEvent.contentOffset.y)
    keyboardAnchorToken.current += 1
    keyboardBottomAnchor.current = false
    cancelSeekAlignment()
    setSearchTargetAlignmentLocked(false)
    dragStartedWithKeyboard.current = keyboardVisible
    if (scrollSettleFrame.current != null) {
      cancelAnimationFrame(scrollSettleFrame.current)
      scrollSettleFrame.current = null
    }
    scrollInteractionToken.current += 1
    momentumInteractionToken.current = null
    userScrolling.current = true
    // Only a real drag opens one paging gate. Native anchor correction and
    // content remeasurement cannot cascade into a second request.
    topLoadArmed.current = !loadingOlder && !olderRequestInFlight.current
    pendingAutomaticOlder.current = false
    if (offset <= TOP_LOAD_TRIGGER && topLoadArmed.current && canLoadOlder && !loadingOlder) {
      pendingAutomaticOlder.current = true
    }
  }, [canLoadOlder, cancelSeekAlignment, keyboardVisible, loadingOlder])
  const handleScrollEndDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const finishKeyboardDismissal = Platform.OS === 'ios'
      && shouldFinishTimelineKeyboardDismissal(dragStartedWithKeyboard.current, event.nativeEvent.velocity?.y)
    dragStartedWithKeyboard.current = false
    if (finishKeyboardDismissal) Keyboard.dismiss()
    const interactionToken = scrollInteractionToken.current
    if (scrollSettleFrame.current != null) cancelAnimationFrame(scrollSettleFrame.current)
    // Momentum begins after drag-end on iOS. Keep the user lock for one
    // frame so a pending live-edge catch-up cannot snap a released fling.
    scrollSettleFrame.current = requestAnimationFrame(() => {
      scrollSettleFrame.current = null
      if (momentumInteractionToken.current != null) return
      finishScrollInteraction(interactionToken)
    })
  }, [finishScrollInteraction])
  const handleMomentumScrollBegin = useCallback(() => {
    if (scrollSettleFrame.current != null) {
      cancelAnimationFrame(scrollSettleFrame.current)
      scrollSettleFrame.current = null
    }
    momentumInteractionToken.current = scrollInteractionToken.current
    userScrolling.current = true
  }, [])
  const handleMomentumScrollEnd = useCallback(() => {
    const interactionToken = momentumInteractionToken.current
    if (interactionToken != null) finishScrollInteraction(interactionToken)
  }, [finishScrollInteraction])
  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = Math.max(0, event.nativeEvent.contentOffset.y)
    if (userScrolling.current && offset <= TOP_LOAD_TRIGGER && topLoadArmed.current && canLoadOlder && !loadingOlder) {
      pendingAutomaticOlder.current = true
    }
    const next = distanceFromBottom(event) < 120
    // At a 32 ms throttle a five-second fling can deliver roughly 156 events.
    // Schedule React work only when this boolean boundary actually changes.
    if (nearBottomRef.current !== next) {
      nearBottomRef.current = next
      setNearBottom(next)
    }
  }, [canLoadOlder, loadingOlder])
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.round(event.nativeEvent.layout.width)
    if (!width || Math.abs(width - viewportWidth) < 2) return
    setViewportWidth(width)
    requestAnimationFrame(() => {
      list.current?.recomputeViewableItems()
    })
  }, [viewportWidth])
  const renderRow = useCallback(
    ({ item }: { item: TimelineRow }) => <TimelineRowView row={item} sessionId={sessionId} onReview={onReview} fontScale={fontScale} layoutWidth={viewportWidth} />,
    [fontScale, onReview, sessionId, viewportWidth],
  )
  const contentContainerStyle = useMemo(
    () => ({ paddingTop: 12, paddingBottom: bottomInset + 68 }),
    [bottomInset],
  )

  const selectedSyncStatus = syncSessionId === sessionId ? syncStatus : 'cached'
  if (!snapshot && (loading || selectedSyncStatus === 'syncing' || selectedSyncStatus === 'reconnecting')) return <Loading label={selectedSyncStatus === 'reconnecting' ? 'Reconnecting to this chat' : 'Loading latest messages'} />
  return (
    <View style={styles.root} onLayout={handleLayout}>
      <FlashList
        key={activeHistoryWindow?.detached ? `${sessionId}:seek:${activeHistoryWindow.anchorRevision ?? 0}` : sessionId}
        ref={list}
        data={rows}
        keyExtractor={timelineRowKey}
        getItemType={timelineRowType}
        renderItem={renderRow}
        extraData={`${fontScale}:${viewportWidth}`}
        ItemSeparatorComponent={Separator}
        contentContainerStyle={contentContainerStyle}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="always"
        onScrollBeginDrag={handleScrollBeginDrag}
        onScrollEndDrag={handleScrollEndDrag}
        onMomentumScrollBegin={handleMomentumScrollBegin}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        initialScrollIndex={activeHistoryWindow?.detached && seekTargetIndex >= 0 ? seekTargetIndex : undefined}
        maintainVisibleContentPosition={timelineMaintainVisiblePosition(Boolean(activeHistoryWindow?.detached && searchTargetAlignmentLocked))}
        onLoad={() => {
          const revision = activeHistoryWindow?.detached ? activeHistoryWindow.anchorRevision : null
          if (revision != null && seekTargetIndex >= 0 && !userScrolling.current) {
            alignSeekTarget(revision, seekTargetIndex)
          }
        }}
        drawDistance={TIMELINE_DRAW_DISTANCE}
        maxItemsInRecyclePool={MAX_RECYCLED_TIMELINE_ITEMS}
        onScroll={handleScroll}
        scrollEventThrottle={32}
        ListHeaderComponent={activeHistoryWindow || canLoadOlder
          ? <Pressable accessibilityRole={canLoadOlder ? 'button' : undefined} accessibilityLabel={canLoadOlder ? 'Load older messages' : 'Beginning of chat'} disabled={!canLoadOlder || loadingOlder || olderRequestInFlight.current} onPress={() => void requestOlder(true)} style={[styles.older, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            {canLoadOlder
              ? loadingOlder
                ? <Text style={{ color: colors.muted }}>Loading…</Text>
                : <><ArrowUp size={14} color={colors.muted} /><Text style={{ color: colors.muted, fontSize: 12 }}>{activeHistoryWindow?.detached ? 'Viewing search result · Load earlier messages' : 'Load older messages'}</Text></>
              : <Text style={{ color: colors.muted, fontSize: 12 }}>{activeHistoryWindow?.detached ? 'Viewing search result · Beginning of chat' : 'Beginning of chat'}</Text>}
          </Pressable>
          : null}
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
      {shouldShowTimelineLatest(rows.length, nearBottom, Boolean(activeHistoryWindow?.detached)) ? <Pressable accessibilityRole="button" accessibilityLabel={activeHistoryWindow ? 'Return to latest message' : 'Scroll to latest message'} onPress={scrollToLatest} style={[styles.bottom, activeHistoryWindow ? styles.bottomLatest : styles.bottomIcon, { bottom: bottomInset + 12, backgroundColor: colors.raised, borderColor: colors.border }]}><ArrowDown size={17} color={colors.text} />{activeHistoryWindow ? <Text style={[styles.bottomLabel, { color: colors.text }]}>Latest</Text> : null}</Pressable> : null}
    </View>
  )
}

function distanceFromBottom(event: NativeSyntheticEvent<NativeScrollEvent>): number {
  const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
  return Math.max(0, contentSize.height - layoutMeasurement.height - contentOffset.y)
}
function timelineRowKey(row: TimelineRow): string { return row.key }
function timelineRowType(row: TimelineRow): string {
  // Role and system semantics are durable for a row key. Avoid types based on
  // attachment resolution or active state because those can change in place
  // and would force FlashList to replace an anchored cell.
  if (row.kind === 'message') return `message:${row.role}`
  if (row.kind === 'system') {
    if (codexLifecycleSemanticKey(row.event)) return 'system:lifecycle'
    if (isHandoffDigestEvent(row.event)) return 'system:digest'
    if (isTimelineError(row.event)) return 'system:error'
  }
  return row.kind
}
function Separator() { return <View style={{ height: 10 }} /> }
const styles = StyleSheet.create({
  root: { flex: 1 },
  older: { minHeight: 44, marginHorizontal: 14, marginBottom: 10, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  empty: { minHeight: 220, paddingHorizontal: 28, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 15, fontWeight: '800', marginBottom: 7 },
  emptyDetail: { fontSize: 12, lineHeight: 17, textAlign: 'center', maxWidth: 360 },
  retry: { marginTop: 14, minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 7 },
  bottom: { position: 'absolute', right: 17, minWidth: 44, height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  bottomIcon: { width: 44 },
  bottomLatest: { paddingHorizontal: 13, flexDirection: 'row', gap: 6 },
  bottomLabel: { fontSize: 12, fontWeight: '800' },
})
