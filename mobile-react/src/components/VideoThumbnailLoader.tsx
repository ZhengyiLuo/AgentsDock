import { useEvent } from 'expo'
import { useEffect, useMemo } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useVideoPlayer, type VideoThumbnail } from 'expo-video'
import type { AgentServerClient } from '../api/AgentServerClient'
import type { AgentFile } from '../types'

interface VideoThumbnailConnection {
  readonly client: AgentServerClient
  readonly sessionId: string
}

export function VideoThumbnailLoader({ file, connection, onThumbnail, onFailure }: {
  file: AgentFile
  connection: VideoThumbnailConnection
  onThumbnail: (value: VideoThumbnail) => void
  onFailure: () => void
}) {
  const source = useMemo(
    () => ({ uri: connection.client.fileURL(connection.sessionId, file.id), headers: connection.client.authHeaders(), contentType: 'progressive' as const }),
    [connection, file.id],
  )
  const player = useVideoPlayer(source, value => {
    value.muted = true
    value.timeUpdateEventInterval = 0
    value.keepScreenOnWhilePlaying = false
    value.staysActiveInBackground = false
    value.showNowPlayingNotification = false
    value.allowsExternalPlayback = false
    value.bufferOptions = { preferredForwardBufferDuration: 2, waitsToMinimizeStalling: false }
  })
  const { status } = useEvent(player, 'statusChange', { status: player.status })

  useEffect(() => {
    if (status === 'error') {
      onFailure()
      return
    }
    if (status !== 'readyToPlay') return
    let active = true
    const requestedTime = Math.min(0.5, Math.max(0, player.duration * 0.05))
    void player.generateThumbnailsAsync(requestedTime, { maxWidth: 320, maxHeight: 180 })
      .then(values => {
        if (!active) return
        if (values[0]) onThumbnail(values[0])
        else onFailure()
      })
      .catch(() => { if (active) onFailure() })
    return () => { active = false }
  }, [onFailure, onThumbnail, player, status])
  useEffect(() => {
    const timeout = setTimeout(onFailure, 8_000)
    return () => clearTimeout(timeout)
  }, [onFailure])

  return <View style={styles.loading}><ActivityIndicator color="white" /></View>
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#090a0b' },
})
