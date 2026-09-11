import { useCallback, useEffect, useRef, useState } from 'react'
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from 'react-native'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'

export interface TextPromptOptions {
  title: string
  message?: string
  initialValue?: string
  confirmLabel?: string
  destructive?: boolean
  placeholder?: string
}

/**
 * Alert.prompt exists only on iOS. This app-owned prompt keeps file and folder
 * mutations usable on Android while giving both platforms the same keyboard,
 * dismissal, and minimum-touch-target behavior.
 */
export function useTextPrompt() {
  const [request, setRequest] = useState<TextPromptOptions | null>(null)
  const [value, setValue] = useState('')
  const resolver = useRef<((value: string | null) => void) | null>(null)
  const input = useRef<TextInput>(null)

  const settle = useCallback((result: string | null) => {
    const resolve = resolver.current
    resolver.current = null
    input.current?.blur()
    dismissAppKeyboard()
    setRequest(null)
    resolve?.(result)
  }, [])

  const promptText = useCallback((options: TextPromptOptions): Promise<string | null> => {
    resolver.current?.(null)
    setValue(options.initialValue ?? '')
    setRequest(options)
    return new Promise(resolve => { resolver.current = resolve })
  }, [])

  useEffect(() => () => {
    resolver.current?.(null)
    resolver.current = null
  }, [])

  const colors = usePalette()
  const textPromptDialog = <Modal
    visible={request !== null}
    transparent
    animationType="fade"
    statusBarTranslucent={Platform.OS === 'android'}
    onRequestClose={() => settle(null)}
    onShow={() => requestAnimationFrame(() => input.current?.focus())}
  >
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.backdrop}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel text entry"
        style={StyleSheet.absoluteFill}
        onPress={() => settle(null)}
      />
      {request ? <View
        accessibilityViewIsModal
        style={[styles.dialog, { backgroundColor: colors.surface, borderColor: colors.border }]}
      >
        <Text style={[styles.title, { color: colors.text }]}>{request.title}</Text>
        {request.message ? <Text style={[styles.message, { color: colors.muted }]}>{request.message}</Text> : null}
        <TextInput
          ref={input}
          testID="text-prompt-input"
          accessibilityLabel={request.title}
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          selectTextOnFocus
          placeholder={request.placeholder}
          placeholderTextColor={colors.muted}
          returnKeyType="done"
          submitBehavior="blurAndSubmit"
          onSubmitEditing={() => { if (value.trim()) settle(value) }}
          style={[styles.input, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]}
        />
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={() => settle(null)}
            style={({ pressed }) => [styles.button, { backgroundColor: colors.raised, opacity: pressed ? 0.65 : 1 }]}
          ><Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text></Pressable>
          <Pressable
            testID="text-prompt-confirm"
            accessibilityRole="button"
            accessibilityLabel={request.confirmLabel ?? 'OK'}
            accessibilityState={{ disabled: !value.trim() }}
            disabled={!value.trim()}
            onPress={() => settle(value)}
            style={({ pressed }) => [styles.button, {
              backgroundColor: request.destructive ? colors.red : colors.blue,
              opacity: !value.trim() ? 0.35 : pressed ? 0.65 : 1,
            }]}
          ><Text style={[styles.buttonText, { color: 'white' }]}>{request.confirmLabel ?? 'OK'}</Text></Pressable>
        </View>
      </View> : null}
    </KeyboardAvoidingView>
  </Modal>

  return { promptText, textPromptDialog }
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.48)',
    paddingHorizontal: 22,
  },
  dialog: {
    width: '100%',
    maxWidth: 440,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 18,
    gap: 12,
    elevation: 14,
    shadowColor: '#000',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  title: { fontSize: 18, lineHeight: 23, fontWeight: '800' },
  message: { fontSize: 13, lineHeight: 18 },
  input: {
    minHeight: 48,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10 },
  button: { minWidth: 88, minHeight: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontSize: 14, fontWeight: '800' },
})
