export function newestBetaVersionFromAtom(feed: string): string | null
export interface CompatibleRelease {
  version: string
  track: 'stable' | 'beta'
}
export function newestCompatibleReleaseFromAtom(feed: string): CompatibleRelease | null
