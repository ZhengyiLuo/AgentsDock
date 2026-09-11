import 'react-native-gesture-handler'
import { useEffect } from 'react'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { AppTypographyProvider } from './src/components/AppText'
import { AppShell } from './src/components/AppShell'
import { trackEvent } from './src/lib/analytics'
import { usePalette } from './src/theme'

export default function App() {
  const colors = usePalette()
  useEffect(() => {
    trackEvent('app_launched')
  }, [])
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardProvider preload={false}>
        <AppTypographyProvider>
          <SafeAreaProvider>
            <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top', 'left', 'right']}>
              <AppShell />
            </SafeAreaView>
            <StatusBar style="auto" />
          </SafeAreaProvider>
        </AppTypographyProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  )
}
