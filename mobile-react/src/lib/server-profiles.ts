import type {
  AddServerProfileInput,
  Backend,
  ChatDefaults,
  StoredProfileSettings,
  StoredServerProfile,
  UpdateServerProfileInput,
  WorkspacePreferences,
} from '../types'
import { normalizeServerURL } from './format'
import { parseStoredChatReferences } from './chat-references'
import { parseStoredTeamReferences } from './team-references'
import { DEFAULT_SERVER_URL, inferServerConfigured } from './server-setup'
import { APP_FONT_SCALE_DEFAULT, clampAppFontScale } from './typography'

export const PROFILE_SETTINGS_SCHEMA_VERSION = 2 as const
export const DEFAULT_PROFILE_ID = 'default-profile'
export const DEFAULT_CREDENTIAL_VERSION = 1

export interface LegacyStoredSettingsV1 {
  serverURL?: unknown
  serverConfigured?: unknown
  serverIdentity?: unknown
  selectedSessionId?: unknown
  folderOrder?: unknown
  fontScale?: unknown
}

export interface ProfileSettingsMigration {
  settings: StoredProfileSettings
  workspace: WorkspacePreferences
}

export function profileNamespace(profile: Pick<StoredServerProfile, 'id' | 'serverIdentity'>): string {
  return cleanServerIdentity(profile.serverIdentity) || `profile:${requireProfileId(profile.id)}`
}

export function legacyURLCacheNamespace(serverURL: string): string {
  return normalizeServerURL(serverURL).toLowerCase()
}

/** Produces an injective suffix using only Expo SecureStore-safe characters. */
export function profileCredentialKeySuffix(profileId: string): string {
  const id = requireProfileId(profileId)
  return Array.from(id, character => character.codePointAt(0)!.toString(16)).join('-')
}

/** Missing legacy values adopt version 1; malformed values never select an arbitrary key. */
export function normalizeCredentialVersion(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= DEFAULT_CREDENTIAL_VERSION
    ? value
    : DEFAULT_CREDENTIAL_VERSION
}

export function nextCredentialVersion(currentValue: unknown): number {
  const current = normalizeCredentialVersion(currentValue)
  if (current >= Number.MAX_SAFE_INTEGER) throw new Error('The server credential version cannot be advanced safely.')
  return current + 1
}

export function defaultProfileName(serverURL: string, serverIdentity?: string | null): string {
  const identity = cleanServerIdentity(serverIdentity)
  if (identity) return identity
  try {
    const url = new URL(normalizeServerURL(serverURL))
    return url.hostname || url.host || 'AgentsServer'
  } catch {
    return 'AgentsServer'
  }
}

export function findDuplicateProfileByURL(
  profiles: readonly Pick<StoredServerProfile, 'id' | 'serverURL'>[],
  serverURL: string,
  excludingProfileId?: string,
): Pick<StoredServerProfile, 'id' | 'serverURL'> | undefined {
  const candidate = comparableServerURL(serverURL)
  return profiles.find(profile => profile.id !== excludingProfileId && comparableServerURL(profile.serverURL) === candidate)
}

export function findDuplicateProfileByIdentity<T extends Pick<StoredServerProfile, 'id' | 'serverIdentity'>>(
  profiles: readonly T[],
  serverIdentity: string | null | undefined,
  excludingProfileId?: string,
): T | undefined {
  const candidate = cleanServerIdentity(serverIdentity)
  if (!candidate) return undefined
  return profiles.find(profile => profile.id !== excludingProfileId && cleanServerIdentity(profile.serverIdentity) === candidate)
}

export function assertUniqueServerProfile(
  profiles: readonly StoredServerProfile[],
  candidate: Pick<StoredServerProfile, 'serverURL' | 'serverIdentity'>,
  excludingProfileId?: string,
): void {
  const duplicateURL = findDuplicateProfileByURL(profiles, candidate.serverURL, excludingProfileId)
  if (duplicateURL) throw new Error(`A server profile already uses ${normalizeServerURL(candidate.serverURL)}.`)
  const duplicateIdentity = findDuplicateProfileByIdentity(profiles, candidate.serverIdentity, excludingProfileId)
  if (duplicateIdentity) throw new Error(`Server identity ${cleanServerIdentity(candidate.serverIdentity)} already belongs to another profile.`)
}

export function createStoredServerProfile(
  input: AddServerProfileInput,
  profileId: string,
  timestamp = new Date().toISOString(),
): StoredServerProfile {
  const serverURL = normalizeServerURL(input.serverURL)
  const serverIdentity = cleanServerIdentity(input.serverIdentity)
  return {
    id: requireProfileId(profileId),
    name: cleanProfileName(input.name) || defaultProfileName(serverURL, serverIdentity),
    serverURL,
    serverIdentity,
    serverConfigured: input.serverConfigured ?? Boolean(serverIdentity || inferServerConfigured(serverURL, undefined)),
    credentialVersion: DEFAULT_CREDENTIAL_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export function applyStoredServerProfileUpdate(
  current: StoredServerProfile,
  patch: UpdateServerProfileInput,
  timestamp = new Date().toISOString(),
): StoredServerProfile {
  const serverURL = patch.serverURL === undefined ? current.serverURL : normalizeServerURL(patch.serverURL)
  const serverIdentity = patch.resetServerIdentity
    ? null
    : patch.serverIdentity === undefined
      ? current.serverIdentity
      : cleanServerIdentity(patch.serverIdentity)
  return {
    ...current,
    name: patch.name === undefined ? current.name : requireProfileName(patch.name),
    serverURL,
    serverIdentity,
    serverConfigured: patch.serverConfigured ?? current.serverConfigured,
    updatedAt: timestamp,
  }
}

export function normalizeStoredProfileSettings(value: unknown, timestamp = new Date().toISOString()): StoredProfileSettings {
  if (!isRecord(value)) throw new Error('Profile settings must contain a JSON object.')
  if (value.schemaVersion !== PROFILE_SETTINGS_SCHEMA_VERSION) {
    throw new Error(`Unsupported profile settings schema version: ${String(value.schemaVersion)}`)
  }
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error('Profile settings must contain at least one server profile.')
  }
  const profiles = value.profiles.map((profile, index) => normalizeStoredServerProfile(profile, timestamp, index))
  validateProfiles(profiles)
  const profileIds = new Set(profiles.map(profile => profile.id))
  const activeProfileId = typeof value.activeProfileId === 'string' && profileIds.has(value.activeProfileId.trim())
    ? value.activeProfileId.trim()
    : profiles[0].id
  return {
    schemaVersion: PROFILE_SETTINGS_SCHEMA_VERSION,
    activeProfileId,
    profiles,
    fontScale: clampAppFontScale(value.fontScale),
  }
}

export function migrateLegacyProfileSettings(
  value: LegacyStoredSettingsV1 | unknown,
  timestamp = new Date().toISOString(),
  profileId = DEFAULT_PROFILE_ID,
): ProfileSettingsMigration {
  const legacy = isRecord(value) ? value : {}
  const serverURL = normalizeServerURL(typeof legacy.serverURL === 'string' ? legacy.serverURL : DEFAULT_SERVER_URL)
  const serverIdentity = cleanServerIdentity(typeof legacy.serverIdentity === 'string' ? legacy.serverIdentity : null)
  const profile: StoredServerProfile = {
    id: requireProfileId(profileId),
    name: defaultProfileName(serverURL, serverIdentity),
    serverURL,
    serverIdentity,
    serverConfigured: Boolean(serverIdentity) || inferServerConfigured(serverURL, legacy.serverConfigured),
    credentialVersion: DEFAULT_CREDENTIAL_VERSION,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
  return {
    settings: {
      schemaVersion: PROFILE_SETTINGS_SCHEMA_VERSION,
      activeProfileId: profile.id,
      profiles: [profile],
      fontScale: legacy.fontScale === undefined ? APP_FONT_SCALE_DEFAULT : clampAppFontScale(legacy.fontScale),
    },
    workspace: normalizeWorkspacePreferences({
      selectedSessionId: legacy.selectedSessionId,
      folderOrder: legacy.folderOrder,
    }),
  }
}

export function createDefaultProfileSettings(
  timestamp = new Date().toISOString(),
  profileId = DEFAULT_PROFILE_ID,
): ProfileSettingsMigration {
  return migrateLegacyProfileSettings({}, timestamp, profileId)
}

export const DEFAULT_CHAT_DEFAULTS: ChatDefaults = { backend: 'codex', model: '', effort: '', folder: 'General', cwd: '' }

const CHAT_BACKENDS: Backend[] = ['claude', 'codex', 'cursor']

function normalizeChatDefaults(value: unknown): ChatDefaults {
  const parsed = isRecord(value) ? value : {}
  const backend = CHAT_BACKENDS.includes(parsed.backend as Backend) ? parsed.backend as Backend : DEFAULT_CHAT_DEFAULTS.backend
  return {
    backend,
    model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_CHAT_DEFAULTS.model,
    effort: typeof parsed.effort === 'string' ? parsed.effort : DEFAULT_CHAT_DEFAULTS.effort,
    folder: typeof parsed.folder === 'string' && parsed.folder.trim() ? parsed.folder : DEFAULT_CHAT_DEFAULTS.folder,
    cwd: typeof parsed.cwd === 'string' ? parsed.cwd : DEFAULT_CHAT_DEFAULTS.cwd,
  }
}

export function normalizeWorkspacePreferences(value: unknown): WorkspacePreferences {
  const parsed = isRecord(value) ? value : {}
  const selectedSessionId = typeof parsed.selectedSessionId === 'string' && parsed.selectedSessionId.trim()
    ? parsed.selectedSessionId
    : null
  const rawDrafts = isRecord(parsed.drafts) ? parsed.drafts : {}
  const drafts: Record<string, string> = {}
  for (const [sessionId, draft] of Object.entries(rawDrafts)) {
    if (sessionId && typeof draft === 'string' && draft) drafts[sessionId] = draft
  }
  const rawReferences = isRecord(parsed.chatReferencesBySession) ? parsed.chatReferencesBySession : {}
  const chatReferencesBySession: NonNullable<WorkspacePreferences['chatReferencesBySession']> = {}
  for (const [sessionId, references] of Object.entries(rawReferences)) {
    if (!sessionId || !drafts[sessionId]) continue
    const normalized = parseStoredChatReferences(references, drafts[sessionId], sessionId)
    if (normalized.length) chatReferencesBySession[sessionId] = normalized
  }
  const rawTeams = isRecord(parsed.teamReferencesBySession) ? parsed.teamReferencesBySession : {}
  const teamReferencesBySession: NonNullable<WorkspacePreferences['teamReferencesBySession']> = {}
  for (const [sessionId, references] of Object.entries(rawTeams)) {
    if (!sessionId || !drafts[sessionId]) continue
    const normalized = parseStoredTeamReferences(references, drafts[sessionId])
    if (normalized.length) teamReferencesBySession[sessionId] = normalized
  }
  return {
    selectedSessionId,
    folderOrder: cleanStringList(parsed.folderOrder),
    collapsedFolders: cleanStringList(parsed.collapsedFolders),
    drafts,
    ...(Object.keys(chatReferencesBySession).length ? { chatReferencesBySession } : {}),
    ...(Object.keys(teamReferencesBySession).length ? { teamReferencesBySession } : {}),
    // Only surface chatDefaults when the stored workspace actually recorded
    // them. Manufacturing a default here would make a target namespace that
    // never saved defaults appear to own them, which discards custom defaults
    // migrated from a source namespace. Consumers fall back to
    // DEFAULT_CHAT_DEFAULTS when this is absent.
    ...(isRecord(parsed.chatDefaults) ? { chatDefaults: normalizeChatDefaults(parsed.chatDefaults) } : {}),
  }
}

function normalizeStoredServerProfile(value: unknown, timestamp: string, index: number): StoredServerProfile {
  if (!isRecord(value)) throw new Error(`Server profile ${index + 1} is invalid.`)
  const id = requireProfileId(typeof value.id === 'string' ? value.id : '')
  const serverURL = normalizeServerURL(typeof value.serverURL === 'string' ? value.serverURL : DEFAULT_SERVER_URL)
  const serverIdentity = cleanServerIdentity(typeof value.serverIdentity === 'string' ? value.serverIdentity : null)
  const createdAt = cleanTimestamp(value.createdAt) || timestamp
  return {
    id,
    name: cleanProfileName(typeof value.name === 'string' ? value.name : undefined) || defaultProfileName(serverURL, serverIdentity),
    serverURL,
    serverIdentity,
    serverConfigured: typeof value.serverConfigured === 'boolean'
      ? value.serverConfigured
      : Boolean(serverIdentity || inferServerConfigured(serverURL, undefined)),
    credentialVersion: normalizeCredentialVersion(value.credentialVersion),
    createdAt,
    updatedAt: cleanTimestamp(value.updatedAt) || createdAt,
  }
}

function validateProfiles(profiles: StoredServerProfile[]): void {
  const ids = new Set<string>()
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error('Server profile IDs must be unique.')
    ids.add(profile.id)
    assertUniqueServerProfile(profiles, profile, profile.id)
  }
}

function comparableServerURL(value: string): string { return normalizeServerURL(value) }
function cleanServerIdentity(value: string | null | undefined): string | null { return value?.trim() || null }
function cleanProfileName(value: string | undefined): string { return value?.trim() || '' }
function cleanTimestamp(value: unknown): string { return typeof value === 'string' ? value.trim() : '' }

function requireProfileId(value: string): string {
  const id = value.trim()
  if (!id) throw new Error('Server profile ID cannot be empty.')
  return id
}

function requireProfileName(value: string): string {
  const name = cleanProfileName(value)
  if (!name) throw new Error('Server profile name cannot be empty.')
  return name
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
