import { describe, expect, it } from 'vitest'
import { detectTerminalPorts } from './terminal-port-detection'

describe('detectTerminalPorts', () => {
  it('detects and deduplicates explicit loopback URLs', () => {
    expect(detectTerminalPorts([
      'Ready at http://localhost:7007',
      'Again at http://127.0.0.1:7007/viewer',
      'Remote bind: http://0.0.0.0:5173/'
    ].join('\n'))).toEqual([
      { remotePort: 7007, url: 'http://localhost:7007', label: 'Local service' },
      { remotePort: 5173, url: 'http://0.0.0.0:5173/', label: 'Local service' }
    ])
  })

  it('ignores HTTPS URLs because forwarded ports open an HTTP root', () => {
    expect(detectTerminalPorts('Secure API: https://localhost:8443/status https://[::1]:9443/')).toEqual([])
  })

  it('recognizes Viser output and strips terminal escapes', () => {
    expect(detectTerminalPorts('\u001b[32mViser server started at http://localhost:8080\u001b[0m'))
      .toEqual([{ remotePort: 8080, url: 'http://localhost:8080', label: 'Viser' }])
  })

  it('does not suggest implicit, malformed, or out-of-range ports', () => {
    expect(detectTerminalPorts('http://localhost http://example.com:7007 http://localhost:80 http://localhost:70000')).toEqual([])
  })
})
