const url = process.argv[2]
if (!url) throw new Error('Usage: node scripts/debug-renderer.mjs ws://127.0.0.1:PORT/devtools/page/ID')

const socket = new WebSocket(url)
let nextId = 1
const send = (method, params = {}) => socket.send(JSON.stringify({ id: nextId++, method, params }))

socket.addEventListener('open', () => {
  send('Runtime.enable')
  send('Log.enable')
  send('Page.enable')
  setTimeout(() => send('Page.reload', { ignoreCache: true }), 100)
  setTimeout(() => {
    send('Runtime.evaluate', {
      expression: 'JSON.stringify({ text: document.body.innerText, api: typeof window.agentsDock, root: document.getElementById("root")?.innerHTML.slice(0, 500) })',
      returnByValue: true
    })
  }, 2500)
  setTimeout(() => socket.close(), 4500)
})

socket.addEventListener('message', event => {
  const packet = JSON.parse(String(event.data))
  if (packet.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', JSON.stringify(packet.params.exceptionDetails, null, 2))
  if (packet.method === 'Runtime.consoleAPICalled') console.log('CONSOLE', packet.params.type, packet.params.args.map(arg => arg.value ?? arg.description).join(' '))
  if (packet.method === 'Log.entryAdded') console.log('LOG', packet.params.entry.level, packet.params.entry.text)
  if (packet.id && packet.result?.result?.value) console.log('STATE', packet.result.result.value)
})

socket.addEventListener('error', error => console.error('DEBUG SOCKET ERROR', error))
