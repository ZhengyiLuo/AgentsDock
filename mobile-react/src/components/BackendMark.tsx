import { StyleSheet, Text, View } from 'react-native'
import type { Backend } from '../types'

export function BackendMark({ backend, size = 22 }: { backend: Backend; size?: number }) {
  if (backend === 'claude') {
    return <View style={[styles.mark, { width: size, height: size, backgroundColor: '#df7654' }]}><Text style={[styles.claude, { fontSize: size * 0.72 }]}>✦</Text></View>
  }
  return <View style={[styles.mark, { width: size, height: size, backgroundColor: '#5a68f1' }]}><Text style={[styles.codex, { fontSize: size * 0.48 }]}>{'>_'}</Text></View>
}

const styles = StyleSheet.create({
  mark: { borderRadius: 6, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  claude: { color: 'white', fontWeight: '700', lineHeight: 18 },
  codex: { color: 'white', fontWeight: '800', letterSpacing: 0 },
})
