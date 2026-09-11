import {
  PAD_TEXT_PREVIEW_BYTES,
  PHONE_TEXT_PREVIEW_BYTES,
  inferredMobileFileContentType,
  joinWorkspacePath,
  mobileFileViewerKind,
  mobileFileViewerLayout,
  mobileFileViewerPaneVisibility,
  mobileTextPreviewLimit,
  parentWorkspacePath,
  sortFileViewerEntries,
  workspacePathSegments,
  workspaceRelativeSourcePath,
} from './file-viewer'

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`)
}

assertEqual(mobileFileViewerLayout(390, 844), 'phone', 'portrait iPhone uses the compact viewer')
assertEqual(mobileFileViewerLayout(844, 390), 'phone', 'rotated iPhone remains compact')
assertEqual(mobileFileViewerLayout(820, 1180), 'pad', 'portrait iPad uses the split viewer')
assertEqual(mobileFileViewerLayout(1024, 768), 'pad', 'landscape iPad uses the split viewer')
assertEqual(JSON.stringify(mobileFileViewerPaneVisibility('phone', false)), JSON.stringify({ browser: true, preview: false }), 'an iPhone without a selection shows only the browser pane')
assertEqual(JSON.stringify(mobileFileViewerPaneVisibility('phone', true)), JSON.stringify({ browser: false, preview: true }), 'an iPhone selection drills into the preview pane')
assertEqual(JSON.stringify(mobileFileViewerPaneVisibility('pad', false)), JSON.stringify({ browser: true, preview: true }), 'iPad keeps both stable panes mounted without a selection')
assertEqual(JSON.stringify(mobileFileViewerPaneVisibility('pad', true)), JSON.stringify({ browser: true, preview: true }), 'iPad keeps both stable panes mounted with a selection')
assertEqual(mobileTextPreviewLimit('phone'), PHONE_TEXT_PREVIEW_BYTES, 'phone text previews stay memory bounded')
assertEqual(mobileTextPreviewLimit('pad'), PAD_TEXT_PREVIEW_BYTES, 'iPad receives the larger text preview budget')
assertEqual(inferredMobileFileContentType('favicon.ico'), 'image/x-icon', 'ICO inference matches the server preview capability')
assertEqual(inferredMobileFileContentType('scan.tif'), 'image/tiff', 'TIF inference matches the server preview capability')
assertEqual(inferredMobileFileContentType('scan.tiff'), 'image/tiff', 'TIFF inference matches the server preview capability')

for (const [name, contentType, expected] of [
  ['photo.PNG', null, 'image'],
  ['clip.mov', 'application/octet-stream', 'video'],
  ['report.pdf', null, 'pdf'],
  ['README.md', null, 'markdown'],
  ['package.json', 'application/octet-stream', 'text'],
  ['diagram.svg', 'image/svg+xml', 'text'],
  ['archive.zip', 'application/zip', 'unsupported'],
] as const) assertEqual(mobileFileViewerKind(name, contentType), expected, `${name} should choose the correct viewer`)

assertEqual(inferredMobileFileContentType('screen.jpeg'), 'image/jpeg', 'JPEG inference is normalized')
assertEqual(joinWorkspacePath('src/components/', '/App.tsx'), 'src/components/App.tsx', 'workspace paths join safely')
assertEqual(parentWorkspacePath('src/components/App.tsx'), 'src/components', 'workspace parent is stable')
assertEqual(parentWorkspacePath('README.md'), '', 'root file returns the workspace root')
assertEqual(workspaceRelativeSourcePath('/Volumes/Work/repo/src/App.tsx', '/Volumes/Work/repo'), 'src/App.tsx', 'workspace artifact sources resolve inside the root')
assertEqual(workspaceRelativeSourcePath('/Volumes/Work/repository/secret.txt', '/Volumes/Work/repo'), null, 'workspace source containment requires a path boundary')
assertEqual(workspaceRelativeSourcePath('../repo/src/App.tsx', '/Volumes/Work/repo'), null, 'relative artifact sources are rejected')
assertEqual(workspaceRelativeSourcePath('C:\\Work\\Repo\\src\\App.tsx', 'c:\\work\\repo'), 'src/App.tsx', 'Windows workspace sources compare case-insensitively')
assertEqual(workspaceRelativeSourcePath('C:\\src\\App.tsx', 'c:\\'), 'src/App.tsx', 'Windows drive roots retain one path separator')
assertEqual(workspaceRelativeSourcePath('/repo/../outside/file.txt', '/repo'), null, 'normalized traversal cannot escape the workspace root')
assertEqual(workspacePathSegments('src/components').map(value => value.path).join('|'), '|src|src/components', 'breadcrumbs retain each navigable prefix')

const sorted = sortFileViewerEntries([
  { name: 'z.txt', path: 'z.txt', kind: 'file' },
  { name: '.hidden', path: '.hidden', kind: 'file', hidden: true },
  { name: 'src', path: 'src', kind: 'directory' },
  { name: 'a.txt', path: 'a.txt', kind: 'file' },
])
assertEqual(sorted.map(value => value.name).join('|'), 'src|a.txt|z.txt|.hidden', 'directories and visible files sort first')

console.log('adaptive mobile file viewer regressions passed')
