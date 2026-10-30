import { useColorScheme } from 'react-native'
import { useAppearanceStore } from './store/useAppearanceStore'

export const dark = {
  background: '#141414',
  homeFooter: '#070707',
  surface: '#1b1b1b',
  raised: '#262626',
  border: '#383838',
  controlBorder: '#383838',
  controlSurface: '#262626',
  text: '#f2f2f2',
  muted: '#a0a0a0',
  subtle: '#939393',
  onAccent: '#ffffff',
  blue: '#2f8cff',
  green: '#28c76f',
  red: '#ff5d64',
  pink: '#f472b6',
  orange: '#ff9f43',
  yellow: '#e2bd38',
  user: '#193629',
  queued: '#3a3214',
  crossChatSurface: '#332444',
  crossChatBorder: '#685080',
  crossChatControl: '#c9b1eb',
  chatReferenceText: '#d8cffc',
  chatReferenceSurface: '#292344',
  chatReferenceBorder: '#574b80',
} as const

export const light = {
  background: '#fafafa',
  homeFooter: '#dedede',
  surface: '#ffffff',
  raised: '#f0f0f0',
  border: '#e0e0e0',
  controlBorder: '#d4d4d4',
  controlSurface: '#ffffff',
  text: '#202020',
  muted: '#686868',
  subtle: '#737373',
  onAccent: '#ffffff',
  blue: '#0879f9',
  green: '#168c4b',
  red: '#d92d38',
  pink: '#b83280',
  orange: '#c66b14',
  yellow: '#8d7200',
  user: '#e4f3e9',
  queued: '#fff6cf',
  crossChatSurface: '#eee5fb',
  crossChatBorder: '#bca5dc',
  crossChatControl: '#664185',
  chatReferenceText: '#5c4a91',
  chatReferenceSurface: '#f0ecff',
  chatReferenceBorder: '#c7bdeb',
} as const

export type Palette = { [K in keyof typeof dark]: string }
export function usePalette(): Palette {
  const systemScheme = useColorScheme()
  const preference = useAppearanceStore(state => state.preference)
  return (preference === 'system' ? systemScheme : preference) === 'light' ? light : dark
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
export const radius = { sm: 6, md: 8, sheet: 16, round: 999 } as const
export const fontWeight = { regular: '400', medium: '500', semibold: '600', bold: '700' } as const

// UI roles opt in; measured code/terminal text keeps its own metrics.
export const typography = {
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 18 },
  body: { fontSize: 15, lineHeight: 22 },
  title: { fontSize: 17, lineHeight: 24 },
  heading: { fontSize: 20, lineHeight: 28 },
} as const
