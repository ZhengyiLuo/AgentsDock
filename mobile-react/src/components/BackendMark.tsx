import { radius, usePalette } from '../theme'
import { Code2, MousePointer2 } from 'lucide-react-native'
import { Image as VectorImage } from 'expo-image'
import { Image, StyleSheet, View } from 'react-native'
import type { Backend } from '../types'
import { BACKEND_MARK_SOURCES } from '../lib/backend-mark-assets'

export function BackendMark({ backend, size = 22 }: { backend: Backend; size?: number }) {
  const colors = usePalette()
  if (backend === 'opencode') return <Code2 size={size} color={colors.text} />
  if (backend === 'gemini') return <VectorImage source={BACKEND_MARK_SOURCES.gemini} contentFit="contain" style={{ width: size, height: size }} />
  if (backend === 'cursor') {
    return <View style={[styles.cursor, { width: size, height: size, borderRadius: Math.max(4, size * 0.27) }]}><MousePointer2 size={size * 0.68} color="#fff" strokeWidth={2.2} /></View>
  }
  return <Image source={BACKEND_MARK_SOURCES[backend]} resizeMode="contain" accessibilityIgnoresInvertColors style={[styles.mark, { width: size, height: size }]} />
}

const styles = StyleSheet.create({
  mark: { borderRadius: radius.sm },
  cursor: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#151515' },
})
