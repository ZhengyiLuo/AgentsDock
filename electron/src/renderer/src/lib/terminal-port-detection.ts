export interface DetectedTerminalPort {
  remotePort: number
  url: string
  label: string
}

const LOCAL_URL_PATTERN = /http:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::(\d{1,5}))(?=[/?#\s)'"\]}>,]|$)[^\s)'"\]}>,]*/gi
const ANSI_SEQUENCE_PATTERN = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g

/**
 * Finds explicit HTTP loopback development-server URLs in terminal output.
 *
 * An explicit port is required. HTTPS URLs are ignored because forwarded ports
 * currently open an HTTP root. We intentionally return suggestions only;
 * callers must wait for the user to opt in before opening a tunnel.
 */
export function detectTerminalPorts(output: string): DetectedTerminalPort[] {
  const plain = output.replace(ANSI_SEQUENCE_PATTERN, '')
  const looksLikeViser = /\bviser\b/i.test(plain)
  const detected = new Map<number, DetectedTerminalPort>()

  for (const match of plain.matchAll(LOCAL_URL_PATTERN)) {
    const remotePort = Number(match[1])
    if (!Number.isInteger(remotePort) || remotePort < 1_024 || remotePort > 65_535) continue
    if (detected.has(remotePort)) continue
    detected.set(remotePort, {
      remotePort,
      url: trimTerminalPunctuation(match[0]),
      label: looksLikeViser ? 'Viser' : 'Local service'
    })
  }

  return [...detected.values()]
}

function trimTerminalPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}
