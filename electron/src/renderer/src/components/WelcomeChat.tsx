// Localized display strings use semantic catalog keys.
import { t } from '@shared/i18n'
import { useLocale } from '../lib/i18n'
import { useRef, useState, type FormEvent } from 'react'
import { ExternalLink, Plus, Send } from 'lucide-react'
import agentsDockLogo from '../assets/agentsdock-icon.png'
import { welcomeReplyForKind, welcomeReplyKind, WELCOME_SETUP_URL, WELCOME_SHOW_TOKEN_COMMAND, type WelcomeMessage } from '../lib/welcome-chat'

function openExternal(url: string): void {
  void window.agentsDock.native.openExternal(url).catch(() => undefined)
}

/**
 * First-run welcome experience shown in the conversation area before any
 * AgentsServer is configured. It is a self-contained MOCK chat: the intro
 * message explains setup in four steps, and typing produces a local canned
 * reply. It never touches the store, a session, or the network, and disappears
 * once a real server is added.
 */
export function WelcomeChat() {
  useLocale()
  const [messages, setMessages] = useState<WelcomeMessage[]>([])
  const [draft, setDraft] = useState('')
  const nextId = useRef(1)
  const listRef = useRef<HTMLDivElement | null>(null)
  const [introBefore, introAfter] = t('welcome.intro').split('{server}')
  const [startBefore, startAfter] = t('welcome.startInstruction').split('{plus}')

  const send = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (!text) return
    const userMessage: WelcomeMessage = { id: nextId.current++, role: 'user', text }
    const replyKind = welcomeReplyKind(text)
    const reply: WelcomeMessage = { id: nextId.current++, role: 'assistant', text: welcomeReplyForKind(replyKind), replyKind }
    setMessages(current => [...current, userMessage, reply])
    setDraft('')
    requestAnimationFrame(() => {
      const list = listRef.current
      if (!list) return
      if (typeof list.scrollTo === 'function') {
        list.scrollTo({ top: list.scrollHeight })
      } else {
        list.scrollTop = list.scrollHeight
      }
    })
  }

  return <div className="welcome-chat">
    <div className="welcome-chat-scroll" ref={listRef}>
      <div className="welcome-chat-intro">
        <img className="welcome-chat-logo" src={agentsDockLogo} alt="" />
        <h2>{t("ui.WelcomeChat.WelcomeChat.welcome_to_agentsdock_e7495aa")}</h2>
        <p className="welcome-chat-lead">
          {introBefore}<strong>AgentsServer</strong>{introAfter}
        </p>
        <ol className="welcome-steps">
          <li>
            <span className="welcome-step-num">1</span>
            <div className="welcome-step-body">
              <strong>{t("ui.WelcomeChat.WelcomeChat.set_up_your_server_8e99107")}</strong>
              <span>{t("ui.WelcomeChat.WelcomeChat.install_agentsserver_on_a_mac_or_linux_mac_1958502")}</span>
              <button type="button" className="welcome-step-link" onClick={() => openExternal(WELCOME_SETUP_URL)}>{t("ui.WelcomeChat.WelcomeChat.setup_guide_f91058b")}{" "}<span className="welcome-step-host">agentsdock.net/setup</span><ExternalLink size={12} />
              </button>
            </div>
          </li>
          <li>
            <span className="welcome-step-num">2</span>
            <div className="welcome-step-body">
              <strong>{t("ui.WelcomeChat.WelcomeChat.get_your_access_token_1d78f46")}</strong>
              <span>{t("ui.WelcomeChat.WelcomeChat.your_server_prints_an_access_token_when_it_2b3a9a1")}</span>
              <code className="welcome-step-code">{WELCOME_SHOW_TOKEN_COMMAND}</code>
            </div>
          </li>
          <li>
            <span className="welcome-step-num">3</span>
            <div className="welcome-step-body">
              <strong>{t("ui.WelcomeChat.WelcomeChat.connect_your_server_c3728b9")}</strong>
              <span>{t("ui.WelcomeChat.WelcomeChat.add_your_server_s_address_and_access_token_e4e9f1d")}</span>
              <button type="button" className="welcome-step-link" onClick={() => window.dispatchEvent(new Event('agentsdock:server-setup'))}>{t("ui.WelcomeChat.WelcomeChat.connect_to_your_agentsserver_2150fba")}</button>
            </div>
          </li>
          <li>
            <span className="welcome-step-num">4</span>
            <div className="welcome-step-body">
              <strong>{t("ui.WelcomeChat.WelcomeChat.start_chatting_b010f6d")}</strong>
              <span>{startBefore}<Plus size={12} className="welcome-inline-icon" />{startAfter}</span>
            </div>
          </li>
        </ol>
      </div>

      {messages.map(message => <div key={message.id} className={`welcome-msg ${message.role}`}>
        {message.role === 'assistant' && <img className="welcome-msg-avatar" src={agentsDockLogo} alt="" />}
        <div className="welcome-msg-bubble">{message.role === 'assistant' && message.replyKind ? welcomeReplyForKind(message.replyKind) : message.text}</div>
      </div>)}
    </div>

    <form className="welcome-chat-composer" onSubmit={send}>
      <input
        value={draft}
        onChange={event => setDraft(event.target.value)}
        placeholder={t("ui.WelcomeChat.WelcomeChat.try_it_out_say_hi_or_ask_how_to_get_set_up_dc8df33")}
        aria-label={t("ui.WelcomeChat.WelcomeChat.message_the_welcome_preview_e177dc5")}
      />
      <button type="submit" className="primary-button" disabled={!draft.trim()} aria-label={t("ui.WelcomeChat.WelcomeChat.send_f6f4688")}><Send size={15} /></button>
    </form>
  </div>
}
