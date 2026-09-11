const values = new Map<string, string>()
let nextMultiRemove: { started: Promise<void>; noteStarted(): void; release: Promise<void>; allow(): void } | null = null

function delayedOperation(): NonNullable<typeof nextMultiRemove> {
  let noteStarted: () => void = () => {}
  let allow: () => void = () => {}
  return {
    started: new Promise(resolve => { noteStarted = resolve }),
    noteStarted: () => noteStarted(),
    release: new Promise(resolve => { allow = resolve }),
    allow: () => allow(),
  }
}

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> { return values.get(key) ?? null },
  async setItem(key: string, value: string): Promise<void> { values.set(key, value) },
  async removeItem(key: string): Promise<void> { values.delete(key) },
  async getAllKeys(): Promise<string[]> { return [...values.keys()] },
  async multiGet(keys: readonly string[]): Promise<Array<[string, string | null]>> {
    return keys.map(key => [key, values.get(key) ?? null])
  },
  async multiSet(entries: ReadonlyArray<readonly [string, string]>): Promise<void> {
    for (const [key, value] of entries) values.set(key, value)
  },
  async multiRemove(keys: readonly string[]): Promise<void> {
    const delayed = nextMultiRemove
    nextMultiRemove = null
    if (delayed) {
      delayed.noteStarted()
      await delayed.release
    }
    for (const key of keys) values.delete(key)
  },
  async clear(): Promise<void> { values.clear(); nextMultiRemove = null },
  __delayNextMultiRemove(): { started: Promise<void>; release(): void } {
    if (nextMultiRemove) throw new Error('A multiRemove delay is already pending.')
    const delayed = delayedOperation()
    nextMultiRemove = delayed
    return { started: delayed.started, release: delayed.allow }
  },
}

export default AsyncStorage
