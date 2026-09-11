// Local, canned-reply logic for the first-run welcome chat. This is a MOCK: it
// never contacts a server or runs a real agent. It only exists to let a brand-new
// user get a feel for the chat UI and points them at setup. Pure and testable.
import { t } from '@shared/i18n'

export const WELCOME_SETUP_URL = 'https://agentsdock.net/setup.html'
export const WELCOME_SHOW_TOKEN_COMMAND = './install.sh --show-token'

export interface WelcomeMessage {
  id: number
  role: 'assistant' | 'user'
  text: string
  replyKind?: WelcomeReplyKind
}

export type WelcomeReplyKind = 'greeting' | 'setup' | 'fallback'

const GREETING = /^(?:hi|hello|hey|yo|hiya|hola)\b|^(?:嗨|哈罗|哈喽|你好)/i

/** The canned assistant reply to whatever the user typed in the preview chat. */
export function welcomeReply(userText: string): string {
  return welcomeReplyForKind(welcomeReplyKind(userText))
}

export function welcomeReplyKind(userText: string): WelcomeReplyKind {
  const text = userText.trim().toLowerCase()
  if (GREETING.test(text)) return 'greeting'
  if (/help|setup|set up|connect|server|token|start|install|how|帮助|设置|连接|服务端|令牌|开始|安装|如何|怎么/.test(text)) return 'setup'
  return 'fallback'
}

export function welcomeReplyForKind(kind: WelcomeReplyKind): string {
  return t(`welcome.reply.${kind}`, { command: WELCOME_SHOW_TOKEN_COMMAND, url: WELCOME_SETUP_URL })
}
