import { Bot, Code2, MousePointer2, TerminalSquare } from 'lucide-react'
import type { Backend } from '@shared/types'

const BACKEND_MARK_SRC: Record<Backend, string> = {
  claude: './backend-claude.png',
  codex: './backend-codex.png',
  cursor: './backend-cursor.png',
  opencode: ''
}

export function BackendMark({ backend, size = 18 }: { backend: Backend; size?: number }) {
  return (
    <span className={`backend-mark backend-${backend}`} style={{ width: size, height: size }} aria-hidden="true">
      {backend !== 'opencode' && <img
        src={window.agentsDock?.sharedChat ? `/interactive-chat/assets/backend-${backend}.png` : BACKEND_MARK_SRC[backend]}
        alt=""
        draggable={false}
        onError={event => { event.currentTarget.style.display = 'none' }}
      />}
      <span className="backend-fallback">
        {backend === 'opencode' ? <Code2 size={size - 3} /> : backend === 'codex' ? <TerminalSquare size={size - 3} /> : backend === 'cursor' ? <MousePointer2 size={size - 3} /> : <Bot size={size - 3} />}
      </span>
    </span>
  )
}
