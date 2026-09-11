function nameFromURI(uri: string): string {
  const path = uri.split(/[?#]/, 1)[0]
  return decodeURIComponent(path.slice(path.lastIndexOf('/') + 1))
}

export class File {
  readonly name: string
  readonly type = ''

  constructor(readonly uri: string) {
    this.name = nameFromURI(uri)
  }

  async bytes(): Promise<Uint8Array> {
    // Opt-in failure hook: a URI carrying the "#unreadable" fragment models an
    // iOS photo whose bytes cannot be materialized (iCloud not downloaded,
    // limited-library, or a File provider). It never affects other fixtures.
    if (this.uri.includes('#unreadable')) throw new Error('mock: source bytes unavailable')
    return new TextEncoder().encode(`fixture:${this.uri}`)
  }
}
