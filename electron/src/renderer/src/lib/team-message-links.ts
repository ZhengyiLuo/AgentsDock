export interface TeamMessageLinkTarget {
  section: 'feed' | 'mail'
  teamId: string
  messageId: string
  mailboxBox?: 'inbox' | 'sent'
  serverIdentity?: string
}

export function teamMessageLinkURL(target: TeamMessageLinkTarget): string {
  const url = new URL('agentsdock://team-message')
  for (const key of ['section', 'teamId', 'messageId', 'mailboxBox', 'serverIdentity'] as const) {
    const value = target[key]
    if (value !== undefined) url.searchParams.set(key, value)
  }
  return url.href
}

export function parseTeamMessageLink(href: string): TeamMessageLinkTarget | null {
  try {
    const url = new URL(href)
    if (url.protocol !== 'agentsdock:' || url.hostname !== 'team-message'
      || url.username || url.password || url.port || url.pathname || url.hash) return null
    const section = url.searchParams.get('section')
    const teamId = url.searchParams.get('teamId')
    const messageId = url.searchParams.get('messageId')
    const mailboxBox = url.searchParams.get('mailboxBox')
    const serverIdentity = url.searchParams.get('serverIdentity')
    if ((section !== 'feed' && section !== 'mail') || !validIdentifier(teamId) || !validIdentifier(messageId)
      || (mailboxBox !== null && mailboxBox !== 'inbox' && mailboxBox !== 'sent')
      || (serverIdentity !== null && !validIdentifier(serverIdentity))) return null
    return {
      section, teamId, messageId,
      ...(mailboxBox ? { mailboxBox } : {}),
      ...(serverIdentity ? { serverIdentity } : {})
    }
  } catch {
    return null
  }
}

export function openTeamMessageLink(href: string): boolean {
  const target = parseTeamMessageLink(href)
  if (!target) return false
  window.dispatchEvent(new CustomEvent('agentsdock:open-teamspace', { detail: target }))
  return true
}

/** Keep a mail subject literal inside a Markdown label, without changing its target. */
export function escapeTeamMessageLinkLabel(label: string): string {
  return label.replace(/[\r\n]/g, ' ').replace(/([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '\\$1')
}

export function teamMessageLinksInText(text: string): Array<{ href: string; label: string; start: number; end: number }> {
  const links: Array<{ href: string; label: string; start: number; end: number }> = []
  for (const match of text.matchAll(/\[((?:\\[^\r\n]|[^\]\\\r\n])+)\]\((agentsdock:\/\/team-message\?[^\s)]+)\)/gu)) {
    if (parseTeamMessageLink(match[2])) links.push({
      href: match[2], label: match[1].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1'),
      start: match.index, end: match.index + match[0].length
    })
  }
  return links
}

function validIdentifier(value: string | null): value is string {
  return value !== null && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020\u007f]/u.test(value)
}
