import { useColorScheme } from 'react-native'

export const dark = {
  background: '#101112',
  surface: '#18191b',
  raised: '#202225',
  border: '#2b2d31',
  text: '#f4f4f5',
  muted: '#9a9ca2',
  blue: '#2f8cff',
  green: '#28c76f',
  red: '#ff5d64',
  orange: '#ff9f43',
  yellow: '#e2bd38',
  user: '#163f2a',
  queued: '#3a3214',
} as const

export const light = {
  background: '#f6f7f8',
  surface: '#ffffff',
  raised: '#eef0f2',
  border: '#d9dce1',
  text: '#18191b',
  muted: '#686b72',
  blue: '#0879f9',
  green: '#168c4b',
  red: '#d92d38',
  orange: '#c66b14',
  yellow: '#8d7200',
  user: '#dff5e7',
  queued: '#fff6cf',
} as const

export type Palette = { [K in keyof typeof dark]: string }
export function usePalette(): Palette { return useColorScheme() === 'light' ? light : dark }

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const
