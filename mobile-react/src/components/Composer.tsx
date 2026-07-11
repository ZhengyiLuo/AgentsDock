import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { ArrowDown, ArrowUp, CornerDownRight, Paperclip, Send, Square, Trash2, X } from 'lucide-react-native'
import { useAppStore } from '../store/useAppStore'
import { usePalette } from '../theme'
import type { AgentFile, QueuedTurn, UploadRef } from '../types'
import { BackendMark } from './BackendMark'
import { IconButton, Pill } from './ui'

const EMPTY_FILES: AgentFile[] = []
const EMPTY_PENDING: UploadRef[] = []
const EMPTY_QUEUE: QueuedTurn[] = []

export function Composer({ sessionId, onSent }: { sessionId: string; onSent: () => void }) {
  const colors = usePalette()
  const draft = useAppStore(state => state.drafts[sessionId] ?? '')
  const uploads = useAppStore(state => state.uploads[sessionId]) ?? EMPTY_FILES
  const pending = useAppStore(state => state.uploadPending[sessionId]) ?? EMPTY_PENDING
  const snapshot = useAppStore(state => state.snapshots[sessionId])
  const session = useAppStore(state => state.sessions.find(value => value.id === sessionId))
  const active = useAppStore(state => state.activeSessionIds.has(sessionId))
  const setDraft = useAppStore(state => state.setDraft)
  const sendPrompt = useAppStore(state => state.sendPrompt)
  const stopTurn = useAppStore(state => state.stopTurn)
  const attachFiles = useAppStore(state => state.attachFiles)
  const removeUpload = useAppStore(state => state.removeUpload)
  const [sending, setSending] = useState(false)
  const queued = useMemo(() => snapshot?.queuedTurns ?? [], [snapshot?.queuedTurns])

  const send = async (steer = false) => {
    if (sending || !draft.trim()) return
    setSending(true)
    const sent = await sendPrompt(steer)
    setSending(false)
    if (sent) onSent()
  }
  const pick = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
    if (!result.canceled) void attachFiles(result.assets.map(file => ({ uri: file.uri, name: file.name, type: file.mimeType ?? undefined, size: file.size })))
  }

  return (
    <View style={[styles.shell, { borderColor: colors.border, backgroundColor: colors.background }]}>
      {queued.length ? <QueueShelf sessionId={sessionId} /> : null}
      {(uploads.length || pending.length) ? <View style={styles.uploads}>
        {uploads.map(file => <View key={file.id} style={[styles.upload, { backgroundColor: colors.raised }]}><Paperclip size={13} color={colors.muted} /><Text style={[styles.uploadName, { color: colors.text }]} numberOfLines={1}>{file.filename}</Text><IconButton icon={X} size={13} onPress={() => removeUpload(file.id)} label="Remove attachment" /></View>)}
        {pending.map(file => <View key={file.uri} style={[styles.upload, { backgroundColor: colors.raised }]}><Text style={{ color: colors.muted, fontSize: 11 }}>Uploading {file.name}…</Text></View>)}
      </View> : null}
      <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={active ? 'Queue a follow-up…' : 'Message'}
          placeholderTextColor={colors.muted}
          multiline
          textAlignVertical="top"
          scrollEnabled
          autoCorrect
          style={[styles.input, { color: colors.text }]}
        />
        <View style={styles.toolbar}>
          <IconButton icon={Paperclip} onPress={() => void pick()} label="Attach files" />
          {session ? <View style={styles.runtime}><BackendMark backend={session.backend} size={21} /><Text style={[styles.backend, { color: colors.text }]}>{session.backend === 'claude' ? 'Claude' : 'Codex'}</Text><Pill tone="neutral">{session.model || 'Server model'}{session.effort ? ` · ${session.effort}` : ''}</Pill></View> : null}
          <View style={{ flex: 1 }} />
          {active ? <IconButton icon={Square} selected onPress={() => void stopTurn()} label="Stop agent" /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={active ? 'Queue message' : 'Send message'}
            disabled={!draft.trim() || sending}
            onPress={() => void send(false)}
            style={({ pressed }) => [styles.send, { backgroundColor: draft.trim() ? colors.blue : colors.raised, opacity: pressed || sending ? 0.6 : 1 }]}
          >
            <Send size={18} color={draft.trim() ? 'white' : colors.muted} />
          </Pressable>
        </View>
        {active && draft.trim() ? <Pressable onPress={() => void send(true)} style={styles.steer}><CornerDownRight size={13} color={colors.blue} /><Text style={{ color: colors.blue, fontSize: 11, fontWeight: '700' }}>Send now</Text></Pressable> : null}
      </View>
    </View>
  )
}

function QueueShelf({ sessionId }: { sessionId: string }) {
  const colors = usePalette()
  const turns = useAppStore(state => state.snapshots[sessionId]?.queuedTurns) ?? EMPTY_QUEUE
  const update = useAppStore(state => state.updateQueued)
  const remove = useAppStore(state => state.removeQueued)
  const move = useAppStore(state => state.moveQueued)
  const runNow = useAppStore(state => state.runQueuedNow)
  const [editing, setEditing] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  return <View style={styles.queue}>
    <Text style={[styles.queueLabel, { color: colors.muted }]}>Queued {turns.length}</Text>
    {turns.map((turn, index) => <View key={turn.queued_id} style={[styles.queueRow, { backgroundColor: colors.queued, borderColor: colors.yellow }]}>
      {editing === turn.queued_id ? <TextInput autoFocus value={editText} onChangeText={setEditText} multiline style={[styles.queueInput, { color: colors.text }]} onBlur={() => { if (editText.trim() && editText !== turn.prompt) void update(turn.queued_id, editText.trim()); setEditing(null) }} /> : <Pressable style={{ flex: 1 }} onPress={() => { setEditing(turn.queued_id); setEditText(turn.prompt) }}><Text style={[styles.queueText, { color: colors.text }]} numberOfLines={3}>{turn.display_prompt || turn.prompt}</Text></Pressable>}
      <Pressable onPress={() => void runNow(turn.queued_id)} style={styles.runNow}><CornerDownRight size={13} color={colors.yellow} /><Text style={{ color: colors.yellow, fontSize: 11, fontWeight: '700' }}>Now</Text></Pressable>
      <IconButton icon={ArrowUp} size={13} disabled={index === 0} onPress={() => void move(turn.queued_id, 'up')} label="Move up" />
      <IconButton icon={ArrowDown} size={13} disabled={index === turns.length - 1} onPress={() => void move(turn.queued_id, 'down')} label="Move down" />
      <IconButton icon={Trash2} size={13} onPress={() => void remove(turn.queued_id)} label="Remove from queue" />
    </View>)}
  </View>
}

const styles = StyleSheet.create({
  shell: { borderTopWidth: StyleSheet.hairlineWidth, padding: 10, gap: 7 },
  composer: { maxHeight: 260, minHeight: 112, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  input: { minHeight: 58, maxHeight: 178, paddingHorizontal: 14, paddingTop: 12, fontSize: 15.5, lineHeight: 21 },
  toolbar: { height: 45, paddingHorizontal: 7, flexDirection: 'row', alignItems: 'center', gap: 4 },
  runtime: { flexDirection: 'row', alignItems: 'center', gap: 6 }, backend: { fontSize: 12, fontWeight: '700' },
  send: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }, steer: { position: 'absolute', right: 53, bottom: 12, flexDirection: 'row', alignItems: 'center', gap: 3 },
  uploads: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 }, upload: { maxWidth: 220, minHeight: 30, paddingLeft: 8, borderRadius: 6, flexDirection: 'row', alignItems: 'center', gap: 5 }, uploadName: { flex: 1, fontSize: 11 },
  queue: { gap: 5, maxHeight: 210 }, queueLabel: { fontSize: 10, fontWeight: '800', textAlign: 'right' },
  queueRow: { minHeight: 39, borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, flexDirection: 'row', alignItems: 'center', paddingLeft: 10, gap: 2 }, queueText: { fontSize: 12.5, lineHeight: 17 }, queueInput: { flex: 1, minHeight: 36, fontSize: 12.5, paddingVertical: 6 }, runNow: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 5 },
})
