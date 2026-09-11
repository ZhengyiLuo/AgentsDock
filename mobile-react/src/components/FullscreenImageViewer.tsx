import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { cancelAnimation, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated'
import { X, ZoomIn, ZoomOut } from 'lucide-react-native'
import {
  clampImageViewerScale,
  clampImageViewerTranslation,
  IMAGE_VIEWER_MAX_SCALE,
  IMAGE_VIEWER_MIN_SCALE,
  IMAGE_VIEWER_ZOOM_EPSILON,
  imageViewerIsZoomed,
  imageViewerPinchTranslation,
  nextImageViewerScale,
  shouldDismissImageViewer,
} from '../lib/image-viewer-gesture'
import { usePalette } from '../theme'
import { Text } from './AppText'

const SPRING_BACK = { damping: 22, stiffness: 240 }
const ZOOM_TIMING = { duration: 160 }

export function SwipeDismissImage({
  children,
  onDismiss,
  testID,
  gestureTestID,
  style,
  resetKey,
}: {
  children: ReactNode
  onDismiss?: () => void
  testID: string
  gestureTestID: string
  style?: StyleProp<ViewStyle>
  resetKey?: string
}) {
  const colors = usePalette()
  const [committedScale, setCommittedScale] = useState(IMAGE_VIEWER_MIN_SCALE)
  const viewportWidth = useSharedValue(0)
  const viewportHeight = useSharedValue(0)
  const scale = useSharedValue(IMAGE_VIEWER_MIN_SCALE)
  const translateX = useSharedValue(0)
  const translateY = useSharedValue(0)
  const dismissY = useSharedValue(0)
  const pinchStartScale = useSharedValue(IMAGE_VIEWER_MIN_SCALE)
  const pinchStartX = useSharedValue(0)
  const pinchStartY = useSharedValue(0)
  const pinchActive = useSharedValue(false)
  const panStartX = useSharedValue(0)
  const panStartY = useSharedValue(0)
  const panOwnsZoom = useSharedValue(false)
  const dismissEnabled = Boolean(onDismiss)
  const dismiss = useCallback(() => onDismiss?.(), [onDismiss])
  const publishScale = useCallback((value: number) => {
    const bounded = clampImageViewerScale(value)
    setCommittedScale(current => Math.abs(current - bounded) <= 0.001 ? current : bounded)
  }, [])
  const resetZoom = useCallback((animated: boolean) => {
    scale.value = animated ? withTiming(IMAGE_VIEWER_MIN_SCALE, ZOOM_TIMING) : IMAGE_VIEWER_MIN_SCALE
    translateX.value = animated ? withTiming(0, ZOOM_TIMING) : 0
    translateY.value = animated ? withTiming(0, ZOOM_TIMING) : 0
    dismissY.value = animated ? withSpring(0, SPRING_BACK) : 0
    publishScale(IMAGE_VIEWER_MIN_SCALE)
  }, [dismissY, publishScale, scale, translateX, translateY])
  const setScaleFromControl = useCallback((direction: -1 | 1) => {
    cancelAnimation(scale)
    cancelAnimation(translateX)
    cancelAnimation(translateY)
    const nextScale = nextImageViewerScale(scale.value, direction)
    scale.value = withTiming(nextScale, ZOOM_TIMING)
    translateX.value = withTiming(clampImageViewerTranslation(translateX.value, viewportWidth.value, nextScale), ZOOM_TIMING)
    translateY.value = withTiming(clampImageViewerTranslation(translateY.value, viewportHeight.value, nextScale), ZOOM_TIMING)
    dismissY.value = withSpring(0, SPRING_BACK)
    publishScale(nextScale)
  }, [dismissY, publishScale, scale, translateX, translateY, viewportHeight, viewportWidth])
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = Math.max(0, event.nativeEvent.layout.width)
    const height = Math.max(0, event.nativeEvent.layout.height)
    if (Math.abs(viewportWidth.value - width) <= 0.5 && Math.abs(viewportHeight.value - height) <= 0.5) return
    viewportWidth.value = width
    viewportHeight.value = height
    resetZoom(false)
  }, [resetZoom, viewportHeight, viewportWidth])

  useEffect(() => {
    resetZoom(false)
  }, [resetKey, resetZoom])

  const pinchGesture = useMemo(() => Gesture.Pinch()
    .withTestId(`${gestureTestID}-pinch`)
    .cancelsTouchesInView(false)
    .onBegin(() => {
      cancelAnimation(scale)
      cancelAnimation(translateX)
      cancelAnimation(translateY)
      pinchActive.value = true
      dismissY.value = 0
      pinchStartScale.value = scale.value
      pinchStartX.value = translateX.value
      pinchStartY.value = translateY.value
      runOnJS(publishScale)(scale.value)
    })
    .onUpdate(event => {
      const nextScale = clampImageViewerScale(pinchStartScale.value * event.scale)
      translateX.value = imageViewerPinchTranslation(
        pinchStartX.value,
        event.focalX,
        viewportWidth.value,
        pinchStartScale.value,
        nextScale,
      )
      translateY.value = imageViewerPinchTranslation(
        pinchStartY.value,
        event.focalY,
        viewportHeight.value,
        pinchStartScale.value,
        nextScale,
      )
      scale.value = nextScale
    })
    .onEnd(() => {
      if (!imageViewerIsZoomed(scale.value)) {
        scale.value = withSpring(IMAGE_VIEWER_MIN_SCALE, SPRING_BACK)
        translateX.value = withSpring(0, SPRING_BACK)
        translateY.value = withSpring(0, SPRING_BACK)
        runOnJS(publishScale)(IMAGE_VIEWER_MIN_SCALE)
        pinchActive.value = false
        return
      }
      translateX.value = withSpring(clampImageViewerTranslation(translateX.value, viewportWidth.value, scale.value), SPRING_BACK)
      translateY.value = withSpring(clampImageViewerTranslation(translateY.value, viewportHeight.value, scale.value), SPRING_BACK)
      runOnJS(publishScale)(scale.value)
      pinchActive.value = false
    })
    .onFinalize((_event, success) => {
      if (success || !pinchActive.value) return
      cancelAnimation(scale)
      cancelAnimation(translateX)
      cancelAnimation(translateY)
      scale.value = withSpring(pinchStartScale.value, SPRING_BACK)
      translateX.value = withSpring(pinchStartX.value, SPRING_BACK)
      translateY.value = withSpring(pinchStartY.value, SPRING_BACK)
      dismissY.value = withSpring(0, SPRING_BACK)
      pinchActive.value = false
    }), [dismissY, gestureTestID, pinchActive, pinchStartScale, pinchStartX, pinchStartY, publishScale, scale, translateX, translateY, viewportHeight, viewportWidth])

  const panGesture = useMemo(() => Gesture.Pan()
    .withTestId(gestureTestID)
    .minPointers(1)
    .maxPointers(1)
    .minDistance(6)
    .cancelsTouchesInView(false)
    .onBegin(() => {
      panOwnsZoom.value = imageViewerIsZoomed(scale.value)
      panStartX.value = translateX.value
      panStartY.value = translateY.value
      dismissY.value = 0
    })
    .onUpdate(event => {
      if (pinchActive.value) {
        // A second finger can join after this one-finger recognizer became
        // active. Pinch exclusively owns transforms until it finalizes.
        dismissY.value = 0
        return
      }
      if (panOwnsZoom.value) {
        translateX.value = clampImageViewerTranslation(panStartX.value + event.translationX, viewportWidth.value, scale.value)
        translateY.value = clampImageViewerTranslation(panStartY.value + event.translationY, viewportHeight.value, scale.value)
        return
      }
      dismissY.value = dismissEnabled ? Math.max(0, event.translationY) : 0
    })
    .onEnd(event => {
      if (pinchActive.value) {
        dismissY.value = withSpring(0, SPRING_BACK)
        return
      }
      if (panOwnsZoom.value || imageViewerIsZoomed(scale.value)) {
        translateX.value = withSpring(clampImageViewerTranslation(translateX.value, viewportWidth.value, scale.value), SPRING_BACK)
        translateY.value = withSpring(clampImageViewerTranslation(translateY.value, viewportHeight.value, scale.value), SPRING_BACK)
        return
      }
      if (dismissEnabled && shouldDismissImageViewer(event.translationX, event.translationY, event.velocityY)) {
        runOnJS(dismiss)()
        return
      }
      dismissY.value = withSpring(0, SPRING_BACK)
    })
    .onFinalize((_event, success) => {
      if (!success) dismissY.value = withSpring(0, SPRING_BACK)
    }), [dismiss, dismissEnabled, dismissY, gestureTestID, panOwnsZoom, panStartX, panStartY, pinchActive, scale, translateX, translateY, viewportHeight, viewportWidth])
  const imageGesture = useMemo(() => Gesture.Simultaneous(pinchGesture, panGesture), [panGesture, pinchGesture])
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: Math.max(0.45, 1 - dismissY.value / 360),
    transform: [
      { translateX: translateX.value },
      { translateY: translateY.value + dismissY.value },
      { scale: scale.value },
    ],
  }))

  const zoomed = committedScale > IMAGE_VIEWER_MIN_SCALE + IMAGE_VIEWER_ZOOM_EPSILON
  const zoomLabel = `${Number(committedScale.toFixed(1))}×`
  return <View onLayout={handleLayout} style={[style, styles.zoomViewport]}>
    <GestureDetector gesture={imageGesture}>
      <Animated.View collapsable={false} testID={testID} style={[StyleSheet.absoluteFill, animatedStyle]}>
        {children}
      </Animated.View>
    </GestureDetector>
    <View pointerEvents="box-none" style={styles.zoomControlsPosition}>
      <View style={[styles.zoomControls, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Zoom image out"
          accessibilityState={{ disabled: !zoomed }}
          testID={`${testID}-zoom-out`}
          disabled={!zoomed}
          hitSlop={4}
          onPress={() => setScaleFromControl(-1)}
          style={({ pressed }) => [styles.zoomButton, { opacity: !zoomed ? 0.3 : pressed ? 0.62 : 1 }]}
        >
          <ZoomOut size={19} color={colors.text} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset image zoom"
          accessibilityState={{ disabled: !zoomed }}
          testID={`${testID}-zoom-reset`}
          disabled={!zoomed}
          hitSlop={4}
          onPress={() => resetZoom(true)}
          style={({ pressed }) => [styles.zoomButton, { opacity: !zoomed ? 0.3 : pressed ? 0.62 : 1 }]}
        >
          <Text style={[styles.zoomLabel, { color: colors.text }]}>{zoomLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Zoom image in"
          accessibilityState={{ disabled: committedScale >= IMAGE_VIEWER_MAX_SCALE - IMAGE_VIEWER_ZOOM_EPSILON }}
          testID={`${testID}-zoom-in`}
          disabled={committedScale >= IMAGE_VIEWER_MAX_SCALE - IMAGE_VIEWER_ZOOM_EPSILON}
          hitSlop={4}
          onPress={() => setScaleFromControl(1)}
          style={({ pressed }) => [styles.zoomButton, { opacity: committedScale >= IMAGE_VIEWER_MAX_SCALE - IMAGE_VIEWER_ZOOM_EPSILON ? 0.3 : pressed ? 0.62 : 1 }]}
        >
          <ZoomIn size={19} color={colors.text} />
        </Pressable>
      </View>
    </View>
  </View>
}

export function SwipeDismissVideoSurface({
  onDismiss,
  testID,
  gestureTestID,
  style,
}: {
  onDismiss: () => void
  testID: string
  gestureTestID: string
  style?: StyleProp<ViewStyle>
}) {
  const dismissGesture = useMemo(() => Gesture.Pan()
    .withTestId(gestureTestID)
    .minPointers(1)
    .maxPointers(1)
    .activeOffsetY(8)
    .failOffsetY(-12)
    .failOffsetX([-96, 96])
    .cancelsTouchesInView(false)
    .onEnd(event => {
      if (shouldDismissImageViewer(event.translationX, event.translationY, event.velocityY)) {
        runOnJS(onDismiss)()
      }
    }), [gestureTestID, onDismiss])

  return <GestureDetector gesture={dismissGesture}>
    <View collapsable={false} testID={testID} style={style} />
  </GestureDetector>
}

export function FullscreenViewerCloseButton({ onPress, label, testID }: { onPress: () => void; label: string; testID: string }) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    testID={testID}
    hitSlop={6}
    onPress={onPress}
    style={({ pressed }) => [styles.close, { backgroundColor: colors.raised, borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}
  >
    <X size={22} color={colors.text} strokeWidth={2.2} />
  </Pressable>
}

const styles = StyleSheet.create({
  close: { width: 48, height: 48, flexShrink: 0, borderRadius: 24, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  zoomViewport: { overflow: 'hidden' },
  zoomControlsPosition: { position: 'absolute', top: 10, right: 10, zIndex: 6 },
  zoomControls: { height: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  zoomButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  zoomLabel: { fontSize: 11, fontWeight: '800', fontVariant: ['tabular-nums'] },
})
