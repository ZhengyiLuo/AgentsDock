import { chatWorkspaceLayout } from './chat-layout'

function assertLayout(width: number, height: number, compact: boolean, inlineInspectorAvailable: boolean, message: string): void {
  const layout = chatWorkspaceLayout(width, height)
  if (layout.compact !== compact || layout.inlineInspectorAvailable !== inlineInspectorAvailable) {
    throw new Error(`${message}: expected ${JSON.stringify({ compact, inlineInspectorAvailable })}, received ${JSON.stringify(layout)}`)
  }
}

assertLayout(719, 1024, true, false, '719pt remains compact without inline inspector')
assertLayout(720, 1024, false, false, '720pt iPad portrait uses the chat/details sheet path')
assertLayout(1079, 1366, false, false, '1079pt cannot mount the inline inspector')
assertLayout(1080, 1366, false, true, '1080pt can mount the inline inspector')
assertLayout(1180, 590, true, false, 'wide but short viewports remain compact')

console.log('chat layout breakpoint regressions passed')
