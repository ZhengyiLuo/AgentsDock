import { MousePointer2 } from 'lucide-react-native'
import { Image, StyleSheet, View } from 'react-native'
import type { Backend } from '../types'

const BACKEND_MARK_SRC = {
  claude: require('../../assets/backend-claude.png'),
  codex: require('../../assets/backend-codex.png'),
} as const

export function BackendMark({ backend, size = 22 }: { backend: Backend; size?: number }) {
  if (backend === 'cursor') {
    return <View style={[styles.cursor, { width: size, height: size, borderRadius: Math.max(4, size * 0.27) }]}><MousePointer2 size={size * 0.68} color="#fff" strokeWidth={2.2} /></View>
  }
  return <Image source={BACKEND_MARK_SRC[backend]} resizeMode="contain" accessibilityIgnoresInvertColors style={[styles.mark, { width: size, height: size }]} />
}

const styles = StyleSheet.create({
  mark: { borderRadius: 6 },
  cursor: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#151515' },
})
