import { useState, type ComponentType } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  FoldVertical,
  Keyboard,
  LocateFixed,
  Minus,
  Palette,
  Plus,
  Redo2,
  Replace,
  Search,
  Undo2,
  UnfoldVertical,
} from 'lucide-react-native'
import { Text } from '../components/AppText'
import { usePalette } from '../theme'
import type { CodeEditorExecuteAction } from './codeEditorProtocol'
import {
  EDITOR_FONT_SIZE_MAX,
  EDITOR_FONT_SIZE_MIN,
  EDITOR_THEME_OPTIONS,
  clampEditorFontSize,
  nextEditorTheme,
  type EditorAppearance,
} from './editorAppearance'

interface MobileCodeEditorToolbarProps {
  compact: boolean
  ready: boolean
  readOnly: boolean
  appearance: EditorAppearance
  onAppearanceChange: (appearance: EditorAppearance) => void
  onExecute: (action: CodeEditorExecuteAction) => void
  onFocus: () => void
}

export function MobileCodeEditorToolbar({
  compact,
  ready,
  readOnly,
  appearance,
  onAppearanceChange,
  onExecute,
  onFocus,
}: MobileCodeEditorToolbarProps) {
  const colors = usePalette()
  const [expanded, setExpanded] = useState(false)
  const disabled = !ready
  const editingDisabled = disabled || readOnly
  const theme = EDITOR_THEME_OPTIONS.find(option => option.id === appearance.theme) ?? EDITOR_THEME_OPTIONS[0]

  const historyAndSearch = <>
    <ToolButton icon={Undo2} label="Undo" testID="code-editor-undo" disabled={editingDisabled} onPress={() => onExecute('undo')} />
    <ToolButton icon={Redo2} label="Redo" testID="code-editor-redo" disabled={editingDisabled} onPress={() => onExecute('redo')} />
    <ToolButton icon={Search} label="Find" testID="code-editor-find" disabled={disabled} onPress={() => onExecute('find')} />
    <ToolButton icon={Replace} label="Find and replace" testID="code-editor-replace" disabled={editingDisabled} onPress={() => onExecute('replace')} />
    <ToolButton icon={LocateFixed} label="Go to line" testID="code-editor-goto-line" disabled={disabled} onPress={() => onExecute('gotoLine')} />
  </>

  const folding = <>
    <ToolButton icon={FoldVertical} label="Fold current block" testID="code-editor-fold" disabled={disabled} onPress={() => onExecute('fold')} />
    <ToolButton icon={UnfoldVertical} label="Unfold current block" testID="code-editor-unfold" disabled={disabled} onPress={() => onExecute('unfold')} />
    <ToolButton icon={ChevronsDownUp} label="Fold all" testID="code-editor-fold-all" disabled={disabled} onPress={() => onExecute('foldAll')} />
    <ToolButton icon={ChevronsUpDown} label="Unfold all" testID="code-editor-unfold-all" disabled={disabled} onPress={() => onExecute('unfoldAll')} />
  </>

  const appearanceControls = <>
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Editor theme: ${theme.label}. Activate for next theme.`}
      testID="code-editor-theme"
      hitSlop={{ top: 5, right: 4, bottom: 5, left: 4 }}
      onPress={() => onAppearanceChange({ ...appearance, theme: nextEditorTheme(appearance.theme) })}
      style={({ pressed }) => [
        styles.themeButton,
        { backgroundColor: colors.raised, borderColor: colors.border, opacity: pressed ? 0.65 : 1 },
      ]}
    >
      <Palette size={14} color={colors.muted} strokeWidth={1.8} />
      {!compact || expanded ? <Text style={[styles.themeLabel, { color: colors.muted }]} numberOfLines={1}>{theme.label}</Text> : null}
    </Pressable>
    <ToolButton
      icon={Minus}
      label="Decrease editor font size"
      testID="code-editor-font-decrease"
      disabled={appearance.fontSize <= EDITOR_FONT_SIZE_MIN}
      onPress={() => onAppearanceChange({ ...appearance, fontSize: clampEditorFontSize(appearance.fontSize - 1) })}
    />
    <View accessibilityLabel={`Editor font size ${appearance.fontSize}`} style={styles.fontValue}>
      <Text style={[styles.fontValueText, { color: colors.muted }]}>{appearance.fontSize}</Text>
    </View>
    <ToolButton
      icon={Plus}
      label="Increase editor font size"
      testID="code-editor-font-increase"
      disabled={appearance.fontSize >= EDITOR_FONT_SIZE_MAX}
      onPress={() => onAppearanceChange({ ...appearance, fontSize: clampEditorFontSize(appearance.fontSize + 1) })}
    />
  </>

  return <View testID="code-editor-toolbar" style={[styles.root, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {historyAndSearch}
      {compact ? <ToolButton
        icon={Ellipsis}
        label={expanded ? 'Hide editor tools' : 'Show more editor tools'}
        testID="code-editor-more"
        selected={expanded}
        onPress={() => setExpanded(value => !value)}
      /> : null}
      {!compact ? folding : null}
      {!compact ? appearanceControls : null}
      <ToolButton icon={Keyboard} label="Focus editor keyboard" testID="code-editor-focus" disabled={disabled} onPress={onFocus} />
    </ScrollView>
    {compact && expanded ? <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={[styles.row, styles.secondaryRow, { borderColor: colors.border }]}
    >
      {folding}
      {appearanceControls}
    </ScrollView> : null}
  </View>
}

function ToolButton({
  icon: Icon,
  label,
  testID,
  onPress,
  disabled = false,
  selected = false,
}: {
  icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>
  label: string
  testID: string
  onPress: () => void
  disabled?: boolean
  selected?: boolean
}) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled, selected }}
    testID={testID}
    disabled={disabled}
    hitSlop={4}
    pressRetentionOffset={12}
    onPress={onPress}
    style={({ pressed }) => [
      styles.toolButton,
      {
        backgroundColor: selected ? colors.raised : 'transparent',
        opacity: disabled ? 0.32 : pressed ? 0.6 : 1,
      },
    ]}
  >
    <Icon size={15} color={selected ? colors.blue : colors.muted} strokeWidth={1.8} />
  </Pressable>
}

const styles = StyleSheet.create({
  root: {
    flexShrink: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    minHeight: 42,
    paddingHorizontal: 4,
    alignItems: 'center',
    gap: 1,
  },
  secondaryRow: {
    minHeight: 40,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toolButton: {
    width: 40,
    height: 40,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 7,
  },
  themeButton: {
    height: 34,
    maxWidth: 144,
    flexShrink: 0,
    paddingHorizontal: 9,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  themeLabel: {
    maxWidth: 104,
    fontSize: 11,
    fontWeight: '600',
  },
  fontValue: {
    width: 24,
    height: 40,
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fontValueText: {
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
})
