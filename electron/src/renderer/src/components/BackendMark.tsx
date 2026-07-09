import { Bot, TerminalSquare } from 'lucide-react'
import type { Backend } from '@shared/types'

export function BackendMark({ backend, size = 18 }: { backend: Backend; size?: number }) {
  return (
    <span className={`backend-mark backend-${backend}`} style={{ width: size, height: size }} aria-label={backend}>
      <img
        src={backend === 'claude' ? './backend-claude.png' : './backend-codex.png'}
        alt=""
        draggable={false}
        onError={event => { event.currentTarget.style.display = 'none' }}
      />
      <span className="backend-fallback">{backend === 'codex' ? <TerminalSquare size={size - 3} /> : <Bot size={size - 3} />}</span>
    </span>
  )
}
