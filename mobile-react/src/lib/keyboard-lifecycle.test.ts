import { initialIOSKeyboardLifecycle, reduceIOSKeyboardLifecycle, type IOSKeyboardLifecycleEvent } from './keyboard-lifecycle'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function apply(events: IOSKeyboardLifecycleEvent[]) {
  return events.reduce(reduceIOSKeyboardLifecycle, initialIOSKeyboardLifecycle(true))
}

const missedBackgroundHide = apply([
  { type: 'keyboard-will-show' },
  { type: 'keyboard-did-show' },
  { type: 'app-state', status: 'background' },
  { type: 'app-state', status: 'background' },
  { type: 'app-state', status: 'active' },
])
assert(!missedBackgroundHide.visible, 'foregrounding without a hide event must not resurrect keyboard visibility')
assert(!missedBackgroundHide.avoidanceEnabled, 'foregrounding without a hide event must clear stale avoiding-view padding')
assert(!missedBackgroundHide.hideCompletionPending, 'background cleanup must revoke cancelled-hide restoration')

const normalHide = apply([
  { type: 'keyboard-will-show' },
  { type: 'keyboard-did-show' },
  { type: 'keyboard-will-hide' },
])
assert(!normalHide.visible, 'will-hide must update interaction state immediately')
assert(normalHide.avoidanceEnabled, 'will-hide must retain avoidance through the interactive animation')
const hidden = reduceIOSKeyboardLifecycle(normalHide, { type: 'keyboard-did-hide' })
assert(!hidden.avoidanceEnabled, 'did-hide must disable avoidance after the animation settles')

const missedWillHide = reduceIOSKeyboardLifecycle(
  apply([
    { type: 'keyboard-will-show' },
    { type: 'keyboard-did-show' },
  ]),
  { type: 'keyboard-did-hide' },
)
assert(!missedWillHide.visible, 'a direct did-hide must clear visibility when iOS omits will-hide')
assert(!missedWillHide.avoidanceEnabled, 'a direct did-hide must clear stale avoiding-view padding')

const missedActiveDidHide = reduceIOSKeyboardLifecycle(normalHide, { type: 'keyboard-hide-timeout' })
assert(!missedActiveDidHide.avoidanceEnabled, 'the hide fallback must clear padding when active iOS omits did-hide')
assert(missedActiveDidHide.hideCompletionPending, 'the hide fallback must retain cancellation recovery until hide completion')

const cancelledAfterTimeout = reduceIOSKeyboardLifecycle(missedActiveDidHide, { type: 'keyboard-did-show' })
assert(cancelledAfterTimeout.visible && cancelledAfterTimeout.avoidanceEnabled, 'did-show must recover a long cancelled dismissal after the fallback fires')
assert(!cancelledAfterTimeout.hideCompletionPending, 'recovering a cancelled dismissal must consume the pending hide')

const backgroundedAfterTimeout = reduceIOSKeyboardLifecycle(missedActiveDidHide, { type: 'app-state', status: 'background' })
const foregroundedAfterTimeout = reduceIOSKeyboardLifecycle(backgroundedAfterTimeout, { type: 'app-state', status: 'active' })
const staleCancellationAfterResume = reduceIOSKeyboardLifecycle(foregroundedAfterTimeout, { type: 'keyboard-did-show' })
assert(!staleCancellationAfterResume.visible && !staleCancellationAfterResume.avoidanceEnabled, 'backgrounding after a hide timeout must prevent stale did-show recovery')

const cancelledInteractiveHide = apply([
  { type: 'keyboard-will-show' },
  { type: 'keyboard-did-show' },
  { type: 'keyboard-will-hide' },
  { type: 'keyboard-will-show' },
])
assert(cancelledInteractiveHide.visible, 'a cancelled interactive hide must restore keyboard visibility')
assert(cancelledInteractiveHide.avoidanceEnabled, 'a cancelled interactive hide must keep avoidance active')
assert(!cancelledInteractiveHide.hideCompletionPending, 'will-show cancellation must clear the pending hide')
const cancelledHideTimeout = reduceIOSKeyboardLifecycle(cancelledInteractiveHide, { type: 'keyboard-hide-timeout' })
assert(cancelledHideTimeout.visible && cancelledHideTimeout.avoidanceEnabled, 'an old hide timeout must not break a cancelled dismissal')

const cancelledByDidShow = reduceIOSKeyboardLifecycle(normalHide, { type: 'keyboard-did-show' })
assert(cancelledByDidShow.visible && cancelledByDidShow.avoidanceEnabled, 'did-show alone must restore an active cancelled dismissal')
const cancelledDidShowTimeout = reduceIOSKeyboardLifecycle(cancelledByDidShow, { type: 'keyboard-hide-timeout' })
assert(cancelledDidShowTimeout.visible && cancelledDidShowTimeout.avoidanceEnabled, 'the fallback must not disable avoidance after did-show cancels a hide')

const lateDidShow = reduceIOSKeyboardLifecycle(missedBackgroundHide, { type: 'keyboard-did-show' })
assert(!lateDidShow.visible && !lateDidShow.avoidanceEnabled, 'a stale did-show after resume must not restore invalid geometry')
const refocused = reduceIOSKeyboardLifecycle(lateDidShow, { type: 'keyboard-will-show' })
assert(refocused.visible && refocused.avoidanceEnabled, 'a fresh focus after resume must restore keyboard avoidance')

const restoredResponderEvents: IOSKeyboardLifecycleEvent[] = [
  { type: 'keyboard-will-show' },
  { type: 'keyboard-will-hide' },
  { type: 'keyboard-hide-timeout' },
]
const restoredResponderWithoutDidHide = restoredResponderEvents.reduce(reduceIOSKeyboardLifecycle, missedBackgroundHide)
assert(!restoredResponderWithoutDidHide.visible && !restoredResponderWithoutDidHide.avoidanceEnabled, 'foreground responder cleanup must settle even when did-hide is omitted again')

const backgroundShow = reduceIOSKeyboardLifecycle(
  reduceIOSKeyboardLifecycle(initialIOSKeyboardLifecycle(true), { type: 'app-state', status: 'background' }),
  { type: 'keyboard-will-show' },
)
assert(!backgroundShow.visible && !backgroundShow.avoidanceEnabled, 'a background keyboard event must not affect layout')

const inactiveWithoutHide = apply([
  { type: 'keyboard-will-show' },
  { type: 'keyboard-did-show' },
  { type: 'app-state', status: 'inactive' },
])
assert(!inactiveWithoutHide.appActive, 'resigning active must immediately revoke keyboard geometry ownership')
assert(!inactiveWithoutHide.visible, 'inactive without a hide event must clear keyboard visibility')
assert(!inactiveWithoutHide.avoidanceEnabled, 'inactive without a hide event must clear avoiding-view padding')
assert(!inactiveWithoutHide.hideCompletionPending, 'inactive cleanup must revoke cancelled-hide restoration')

const inactiveDuringHide = apply([
  { type: 'keyboard-will-show' },
  { type: 'keyboard-did-show' },
  { type: 'keyboard-will-hide' },
  { type: 'app-state', status: 'inactive' },
])
assert(!inactiveDuringHide.visible, 'resigning active during a hide must keep the keyboard hidden')
assert(!inactiveDuringHide.avoidanceEnabled, 'resigning active during a hide must immediately clear padding')
assert(!inactiveDuringHide.hideCompletionPending, 'resigning active during a hide must cancel delayed restoration')

const resumedAfterInactive = reduceIOSKeyboardLifecycle(
  inactiveDuringHide,
  { type: 'app-state', status: 'active' },
)
const staleDidShowAfterInactive = reduceIOSKeyboardLifecycle(
  resumedAfterInactive,
  { type: 'keyboard-did-show' },
)
assert(!staleDidShowAfterInactive.visible, 'a stale did-show after inactive cleanup must not resurrect keyboard visibility')
assert(!staleDidShowAfterInactive.avoidanceEnabled, 'a stale did-show after inactive cleanup must not resurrect padding')
const freshShowAfterInactive = reduceIOSKeyboardLifecycle(
  staleDidShowAfterInactive,
  { type: 'keyboard-will-show' },
)
assert(freshShowAfterInactive.visible, 'a fresh focus after inactive cleanup must restore keyboard visibility')
assert(freshShowAfterInactive.avoidanceEnabled, 'a fresh focus after inactive cleanup must restore avoidance')

console.log('iOS keyboard lifecycle regressions passed')
