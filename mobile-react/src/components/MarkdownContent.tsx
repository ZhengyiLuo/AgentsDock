import { Linking, ScrollView, StyleSheet } from 'react-native'
import Markdown from 'react-native-markdown-display'
import { scaleChatFont } from '../lib/typography'
import { usePalette } from '../theme'

export function MarkdownContent({ value, fontScale = 1 }: { value: string; fontScale?: number }) {
  const colors = usePalette()
  return (
    <Markdown
      onLinkPress={url => { void Linking.openURL(url); return false }}
      style={{
        body: { color: colors.text, fontSize: scaleChatFont(15.5, fontScale), lineHeight: scaleChatFont(23, fontScale) },
        paragraph: { marginTop: 0, marginBottom: 10 },
        heading1: { color: colors.text, fontSize: scaleChatFont(23, fontScale), lineHeight: scaleChatFont(30, fontScale), marginTop: 10, marginBottom: 8 },
        heading2: { color: colors.text, fontSize: scaleChatFont(19, fontScale), lineHeight: scaleChatFont(26, fontScale), marginTop: 10, marginBottom: 7 },
        heading3: { color: colors.text, fontSize: scaleChatFont(17, fontScale), lineHeight: scaleChatFont(24, fontScale), marginTop: 8, marginBottom: 6 },
        link: { color: colors.blue },
        code_inline: { color: colors.text, backgroundColor: colors.raised, borderRadius: 4, paddingHorizontal: 4, fontFamily: 'Menlo' },
        code_block: { color: colors.text, backgroundColor: '#0c1118', borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 10, fontFamily: 'Menlo', fontSize: scaleChatFont(12.5, fontScale), lineHeight: scaleChatFont(18, fontScale) },
        fence: { color: colors.text, backgroundColor: '#0c1118', borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, padding: 10, fontFamily: 'Menlo', fontSize: scaleChatFont(12.5, fontScale), lineHeight: scaleChatFont(18, fontScale) },
        blockquote: { backgroundColor: colors.raised, borderLeftColor: colors.blue, borderLeftWidth: 3, paddingHorizontal: 10 },
        table: { borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth },
        tr: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
        th: { padding: 6 }, td: { padding: 6 },
        bullet_list: { marginBottom: 8 }, ordered_list: { marginBottom: 8 },
      }}
      rules={{
        fence: (node, children, parent, styles) => (
          <ScrollView key={node.key} horizontal nestedScrollEnabled style={styles.fence}>{children}</ScrollView>
        ),
        code_block: (node, children, parent, styles) => (
          <ScrollView key={node.key} horizontal nestedScrollEnabled style={styles.code_block}>{children}</ScrollView>
        ),
      }}
    >{value}</Markdown>
  )
}
