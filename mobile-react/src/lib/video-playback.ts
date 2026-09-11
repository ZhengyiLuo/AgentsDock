export function validVideoDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

export function clampVideoTime(value: number, duration: number): number {
  const validDuration = validVideoDuration(duration)
  if (!validDuration || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(validDuration, value))
}

export function videoTimeAtPosition(position: number, width: number, duration: number): number {
  const validDuration = validVideoDuration(duration)
  if (!validDuration || !Number.isFinite(position) || !Number.isFinite(width) || width <= 0) return 0
  return clampVideoTime((position / width) * validDuration, validDuration)
}

export function videoProgress(value: number, duration: number): number {
  const validDuration = validVideoDuration(duration)
  if (!validDuration) return 0
  return clampVideoTime(value, validDuration) / validDuration
}

export function formatVideoTime(value: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainingSeconds = seconds % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
}
