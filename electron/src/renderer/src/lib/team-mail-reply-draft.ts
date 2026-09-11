export interface MailReplyDraft {
  body: string
  attempt: { body: string; subject: string | null; recipientId: string; idempotencyKey: string } | null
}

const failedStorageReplyDrafts = new Map<string, MailReplyDraft | null>()
const pendingStorageReplyDrafts = new Map<string, { draft: MailReplyDraft | null; timer: ReturnType<typeof setTimeout> }>()

export function readMailReplyDraft(key: string): MailReplyDraft {
  let value: Partial<MailReplyDraft> | null
  try {
    value = pendingStorageReplyDrafts.has(key) ? pendingStorageReplyDrafts.get(key)!.draft
      : failedStorageReplyDrafts.has(key) ? failedStorageReplyDrafts.get(key) ?? null
        : JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<MailReplyDraft> | null
  } catch { value = failedStorageReplyDrafts.get(key) ?? null }
  const attempt = value?.attempt
  if (typeof value?.body !== 'string' || !(attempt === null || attempt
    && typeof attempt.body === 'string' && typeof attempt.recipientId === 'string'
    && typeof attempt.idempotencyKey === 'string' && attempt.idempotencyKey.length > 0
    && (attempt.subject === null || typeof attempt.subject === 'string'))) return { body: '', attempt: null }
  return { body: attempt?.body ?? value.body, attempt: attempt ? { ...attempt } : null }
}

export function saveMailReplyDraft(key: string, draft: MailReplyDraft | null): void {
  const pending = pendingStorageReplyDrafts.get(key)
  if (pending) clearTimeout(pending.timer)
  pendingStorageReplyDrafts.delete(key)
  try {
    if (draft) localStorage.setItem(key, JSON.stringify(draft))
    else localStorage.removeItem(key)
    failedStorageReplyDrafts.delete(key)
  } catch {
    failedStorageReplyDrafts.delete(key)
    failedStorageReplyDrafts.set(key, draft ? { ...draft, attempt: draft.attempt ? { ...draft.attempt } : null } : null)
    while (failedStorageReplyDrafts.size > 64) {
      failedStorageReplyDrafts.delete(failedStorageReplyDrafts.keys().next().value!)
    }
  }
}

export function flushMailReplyDraft(key: string): void {
  const pending = pendingStorageReplyDrafts.get(key)
  if (pending) saveMailReplyDraft(key, pending.draft)
}

export function queueMailReplyDraft(key: string, draft: MailReplyDraft | null): void {
  const previous = pendingStorageReplyDrafts.get(key)
  if (previous) clearTimeout(previous.timer)
  // Typing updates memory only. One trailing disk write serializes the latest
  // body; close/page exit/Send flush immediately. Confirmed deletion cancels
  // this same pending entry, so no stale timer can resurrect a sent draft.
  const pending = { draft, timer: setTimeout(() => {
    if (pendingStorageReplyDrafts.get(key) === pending) flushMailReplyDraft(key)
  }, 400) }
  pendingStorageReplyDrafts.set(key, pending)
}
