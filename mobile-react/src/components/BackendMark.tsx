import { Image, StyleSheet } from 'react-native'
import type { Backend } from '../types'

export function BackendMark({ backend, size = 22 }: { backend: Backend; size?: number }) {
  const source = backend === 'claude'
    ? require('../../assets/backend-claude.png')
    : require('../../assets/backend-codex.png')
  return <Image source={source} resizeMode="contain" accessibilityIgnoresInvertColors style={[styles.mark, { width: size, height: size }]} />
}

const styles = StyleSheet.create({
  mark: { borderRadius: 6 },
})
