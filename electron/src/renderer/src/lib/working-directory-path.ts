export function parentDirectory(path: string): string {
  const trimmed = path.trim()
  if (!trimmed) return trimmed

  // Preserve filesystem roots so the caller can disable navigation there.
  if (/^[A-Za-z]:[\\/]?$/.test(trimmed) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]*$/.test(trimmed)) return trimmed

  const drive = trimmed.match(/^([A-Za-z]:)([\\/])/)
  const withoutTrailingSeparators = trimmed.replace(/[\\/]+$/, '')
  const lastSeparator = Math.max(
    withoutTrailingSeparators.lastIndexOf('/'),
    withoutTrailingSeparators.lastIndexOf('\\')
  )
  if (lastSeparator < 0) return trimmed
  if (drive && lastSeparator === drive[1].length) return `${drive[1]}${drive[2]}`
  if (lastSeparator === 0) return withoutTrailingSeparators[0]
  return withoutTrailingSeparators.slice(0, lastSeparator)
}
