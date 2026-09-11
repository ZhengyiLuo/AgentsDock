import { useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native'
import { MenuView, type MenuAction } from '@expo/ui/community/menu'
import { SafeAreaView } from 'react-native-safe-area-context'
import { Check, ChevronDown, MoreHorizontal, Pencil, Plus, Server, Wifi, X } from 'lucide-react-native'
import {
  buildCreateServerProfileInput,
  buildUpdateServerProfileInput,
  connectionStateLabel,
  draftAccessToken,
  editServerProfileDraft,
  emptyServerProfileDraft,
  findProfileByIdentity,
  initialServerProfileDraft,
  profileConnectionLabel,
  profileHostSubtitle,
  reorderedServerProfileIds,
  requiresIdentityResetConfirmation,
  unreadCountLabel,
  type CreateServerProfileInput,
  type ServerConnectionTestResult,
  type ServerProfileConnectionState,
  type ServerProfileDraftValues,
  type ServerProfileEditorInitialMode,
  type ServerProfileListItem,
  type ServerProfileTestInput,
  type UpdateServerProfileInput,
} from '../lib/server-profile-ui'
import { usePalette } from '../theme'
import { Text, TextInput } from './AppText'
import { IconButton, SheetCloseButton } from './ui'

export type {
  CreateServerProfileInput,
  ServerConnectionTestResult,
  ServerProfileConnectionState,
  ServerProfileListItem,
  ServerProfileTestInput,
  UpdateServerProfileInput,
} from '../lib/server-profile-ui'

type Awaitable<T> = T | Promise<T>
type ActionResult = boolean | void
type CreatedProfile = string | Pick<ServerProfileListItem, 'id'>

interface CommonServerProfileProps {
  profiles: readonly ServerProfileListItem[]
  activeProfileId: string | null
  switchingProfileId?: string | null
}

export interface ServerProfileSelectorProps extends CommonServerProfileProps {
  disabled?: boolean
  onSelectProfile: (profileId: string) => Awaitable<ActionResult>
  onAddServer: () => void
  onManageServers: () => void
}

export interface ServerProfilesManagerProps extends CommonServerProfileProps {
  initialMode?: ServerProfileEditorInitialMode
  onSwitchProfile: (profileId: string) => Awaitable<ActionResult>
  onTestConnection: (input: ServerProfileTestInput) => Awaitable<ServerConnectionTestResult>
  onCreateProfile: (input: CreateServerProfileInput) => Awaitable<CreatedProfile>
  onUpdateProfile: (profileId: string, patch: UpdateServerProfileInput) => Awaitable<void>
  onReorderProfiles: (orderedProfileIds: string[]) => Awaitable<void>
  onRemoveProfile: (profileId: string) => Awaitable<void>
}

export interface ServerProfilesSheetProps extends ServerProfilesManagerProps {
  visible: boolean
  onClose: () => void
}

export function ServerProfileSelector({
  profiles,
  activeProfileId,
  switchingProfileId = null,
  disabled = false,
  onSelectProfile,
  onAddServer,
  onManageServers,
}: ServerProfileSelectorProps) {
  const colors = usePalette()
  const active = profiles.find(profile => profile.id === activeProfileId) ?? profiles[0] ?? null
  const switching = profiles.find(profile => profile.id === switchingProfileId) ?? null
  const host = active ? profileHostSubtitle(active) : null
  const unavailable = disabled || Boolean(switchingProfileId)
  const selectorLabel = switching
    ? `Switching to ${switching.name}. Please wait.`
    : active
      ? `${active.name}, ${profileConnectionLabel(active)}${active.cachedUnreadCount > 0 ? `, ${active.cachedUnreadCount} unread` : ''}. Choose agent server.`
      : 'Choose agent server'
  const profileActions: MenuAction[] = profiles.length
    ? profiles.map(profile => ({
        id: `profile:${encodeURIComponent(profile.id)}`,
        title: profile.cachedUnreadCount > 0 ? `${profile.name} · ${profile.cachedUnreadCount} unread` : profile.name,
        state: profile.id === activeProfileId ? 'on' : 'off',
        attributes: { disabled: unavailable },
      }))
    : [{ id: 'no-profiles', title: 'No saved servers', attributes: { disabled: true } }]
  const actions: MenuAction[] = [
    { id: 'profiles', title: 'Servers', displayInline: true, subactions: profileActions },
    { id: 'add', title: 'Add Server', image: 'plus', attributes: { disabled } },
    { id: 'manage', title: 'Manage Servers', image: 'gearshape', attributes: { disabled } },
  ]
  const trigger = <View
    testID="server-profile-selector"
    accessible
    accessibilityRole="button"
    accessibilityLabel={selectorLabel}
    accessibilityState={{ disabled: unavailable, expanded: false }}
    style={[styles.selector, { backgroundColor: colors.raised, borderColor: colors.border, opacity: disabled ? 0.4 : 1 }]}
  >
    <ServerConnectionDot state={switching ? 'connecting' : active?.connectionState ?? 'cached'} label={switching ? `Connecting to ${switching.name}` : active ? profileConnectionLabel(active) : 'No server selected'} />
    <View style={styles.selectorCopy}>
      <Text style={[styles.selectorName, { color: colors.text }]} numberOfLines={1}>{active?.name || 'Choose server'}</Text>
      {host ? <Text style={[styles.selectorHost, { color: colors.muted }]} numberOfLines={1}>{host}</Text> : null}
    </View>
    {active && active.cachedUnreadCount > 0 ? <ServerUnreadBadge count={active.cachedUnreadCount} /> : null}
    {switching ? <ActivityIndicator size="small" color={colors.blue} /> : <ChevronDown size={15} color={colors.muted} />}
  </View>

  if (unavailable) return trigger
  return <MenuView
    title="Servers"
    actions={actions}
    onPressAction={event => {
      const id = event.nativeEvent.event
      if (id === 'add') onAddServer()
      else if (id === 'manage') onManageServers()
      else if (id.startsWith('profile:')) {
        const profileId = decodeURIComponent(id.slice('profile:'.length))
        if (profileId !== activeProfileId) void Promise.resolve(onSelectProfile(profileId)).catch(error => {
          Alert.alert('Could not switch server', errorMessage(error))
        })
      }
    }}
    style={styles.selectorMenu}
  >{trigger}</MenuView>
}

export function ServerProfilesSheet({ visible, onClose, ...props }: ServerProfilesSheetProps) {
  const colors = usePalette()
  return <Modal
    visible={visible}
    animationType="slide"
    presentationStyle={Platform.OS === 'ios' ? 'pageSheet' : 'fullScreen'}
    allowSwipeDismissal
    onRequestClose={onClose}
  >
    <View style={[styles.sheet, { backgroundColor: colors.surface }]}>
      <SafeAreaView style={styles.sheetSafeArea} edges={['bottom']}>
        <View style={styles.grabber} />
        <View style={[styles.sheetHeader, { borderColor: colors.border }]}>
          <View style={styles.sheetHeadingCopy}>
            <Text style={[styles.sheetTitle, { color: colors.text }]}>Servers</Text>
            <Text style={[styles.sheetSubtitle, { color: colors.muted }]}>Each server keeps a separate workspace.</Text>
          </View>
          <SheetCloseButton onPress={onClose} label="Close server management" testID="server-management-close" />
        </View>
        <ServerProfilesManager key={`${visible}:${props.initialMode ?? 'manage'}`} {...props} />
      </SafeAreaView>
    </View>
  </Modal>
}

export function ServerProfilesManager({
  profiles,
  activeProfileId,
  switchingProfileId = null,
  initialMode = 'manage',
  onSwitchProfile,
  onTestConnection,
  onCreateProfile,
  onUpdateProfile,
  onReorderProfiles,
  onRemoveProfile,
}: ServerProfilesManagerProps) {
  const colors = usePalette()
  const [draft, setDraft] = useState<ServerProfileDraftValues | null>(() => initialServerProfileDraft(initialMode, profiles, activeProfileId))
  const [busy, setBusy] = useState<string | null>(null)
  const [tested, setTested] = useState<ServerConnectionTestResult | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success' | 'neutral'; message: string } | null>(null)
  const testLease = useRef(0)
  const editedProfile = useMemo(() => profiles.find(profile => profile.id === draft?.profileId) ?? null, [draft?.profileId, profiles])
  const duplicateProfile = useMemo(
    () => findProfileByIdentity(profiles, tested?.server_identity, draft?.profileId),
    [draft?.profileId, profiles, tested?.server_identity],
  )
  const testedIdentityChanged = Boolean(
    editedProfile?.serverIdentity
    && tested?.server_identity
    && tested.server_identity !== editedProfile.serverIdentity,
  )
  const identityResetRequired = Boolean(editedProfile?.serverIdentity && (
    draft?.resetServerIdentity
    || testedIdentityChanged
    || requiresIdentityResetConfirmation(editedProfile)
    || normalizeComparableURL(draft?.serverUrl) !== normalizeComparableURL(editedProfile.serverUrl)
  ))
  const pendingUpdatePatch = useMemo(
    () => editedProfile && draft ? buildUpdateServerProfileInput(editedProfile, draft) : null,
    [draft, editedProfile],
  )
  const updateConnectionChanged = Boolean(pendingUpdatePatch && (
    pendingUpdatePatch.serverUrl !== undefined
    || pendingUpdatePatch.accessToken !== undefined
    || pendingUpdatePatch.resetServerIdentity === true
  ))
  const updateTestMissing = Boolean(draft?.profileId && updateConnectionChanged && !tested?.server_identity?.trim())
  const identityResetUnconfirmed = Boolean(testedIdentityChanged && !draft?.resetServerIdentity)

  const invalidateTest = () => {
    testLease.current += 1
    setTested(null)
    setFeedback(null)
    if (busy === 'test') setBusy(null)
  }
  const updateDraft = (patch: Partial<ServerProfileDraftValues>, invalidatesTest = false) => {
    if (invalidatesTest) invalidateTest()
    setDraft(current => current ? { ...current, ...patch } : current)
  }
  const openAdd = () => {
    if (busy) return
    invalidateTest()
    setDraft(emptyServerProfileDraft())
  }
  const openEdit = (profile: ServerProfileListItem) => {
    if (busy) return
    invalidateTest()
    setDraft(editServerProfileDraft(profile))
  }
  const closeEditor = () => {
    if (busy) return
    invalidateTest()
    setDraft(null)
  }

  const testConnection = async () => {
    if (!draft?.serverUrl.trim()) return
    const request = ++testLease.current
    const testedDraft = { ...draft }
    const accessToken = draftAccessToken(testedDraft)
    const input: ServerProfileTestInput = {
      ...(testedDraft.profileId ? { profileId: testedDraft.profileId } : {}),
      serverUrl: testedDraft.serverUrl.trim(),
      ...(accessToken !== undefined ? { accessToken } : {}),
    }
    setBusy('test')
    setTested(null)
    setFeedback(null)
    try {
      const result = await onTestConnection(input)
      if (result.ok !== true) throw new Error(result.message || 'Server health check reported unavailable.')
      if (!result.server_identity?.trim()) throw new Error('This AgentsServer did not report a stable server identity.')
      if (request === testLease.current) setTested(result)
    } catch (error) {
      if (request === testLease.current) setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      if (request === testLease.current) setBusy(null)
    }
  }

  const switchProfile = async (profileId: string) => {
    if (profileId === activeProfileId || switchingProfileId || busy) return
    setBusy(`switch:${profileId}`)
    setFeedback(null)
    try {
      const switched = await onSwitchProfile(profileId)
      if (switched === false) throw new Error('The requested server was not activated.')
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const save = async () => {
    if (!draft?.serverUrl.trim() || busy) return
    if (!draft.profileId && !tested?.ok) {
      setFeedback({ tone: 'error', message: 'Test this connection successfully before adding the server.' })
      return
    }
    if (draft.profileId && !editedProfile) {
      setFeedback({ tone: 'error', message: 'This saved server no longer exists.' })
      return
    }
    if (draft.profileId && updateConnectionChanged && !tested?.server_identity?.trim()) {
      setFeedback({ tone: 'error', message: 'Test this exact connection successfully before saving address, token, or identity changes.' })
      return
    }
    if (identityResetUnconfirmed) {
      setFeedback({ tone: 'error', message: 'Confirm the server identity reset before saving this replacement server.' })
      return
    }
    setBusy('save')
    setFeedback(null)
    try {
      if (!draft.profileId && duplicateProfile) {
        const switched = await onSwitchProfile(duplicateProfile.id)
        if (switched === false) throw new Error(`Could not activate the existing “${duplicateProfile.name}” profile.`)
      } else if (draft.profileId && editedProfile) {
        if (duplicateProfile) throw new Error(`This connection belongs to the existing “${duplicateProfile.name}” profile.`)
        const patch = buildUpdateServerProfileInput(editedProfile, draft, tested?.server_identity)
        if (Object.keys(patch).length) await onUpdateProfile(editedProfile.id, patch)
      } else {
        const created = await onCreateProfile(buildCreateServerProfileInput(draft, tested?.server_identity))
        const profileId = typeof created === 'string' ? created : created?.id
        if (!profileId) throw new Error('The server was saved without a profile identifier.')
        const switched = await onSwitchProfile(profileId)
        if (switched === false) throw new Error('The server was saved, but it could not be activated.')
      }
      testLease.current += 1
      setTested(null)
      setDraft(null)
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const moveProfile = async (profileId: string, direction: -1 | 1) => {
    if (busy) return
    const order = reorderedServerProfileIds(profiles, profileId, direction)
    if (!order) return
    setBusy(`move:${profileId}`)
    setFeedback(null)
    try {
      await onReorderProfiles(order)
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const removeProfile = async (profile: ServerProfileListItem) => {
    if (profile.id === activeProfileId || busy) return
    setBusy(`remove:${profile.id}`)
    setFeedback(null)
    try {
      await onRemoveProfile(profile.id)
      if (draft?.profileId === profile.id) setDraft(null)
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const confirmRemove = (profile: ServerProfileListItem) => {
    if (profile.id === activeProfileId || busy) return
    Alert.alert(
      `Remove “${profile.name}”?`,
      'The saved connection will be removed. Its cached chats remain on this device.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove server', style: 'destructive', onPress: () => { void removeProfile(profile) } },
      ],
    )
  }

  const confirmIdentityReset = (enabled: boolean) => {
    if (!enabled) {
      updateDraft({ resetServerIdentity: false })
      return
    }
    Alert.alert(
      'Trust a new server identity?',
      'Only continue if you intentionally replaced or moved this AgentsServer. The previous cached workspace will be preserved.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Allow identity reset', style: 'destructive', onPress: () => updateDraft({ resetServerIdentity: true }) },
      ],
    )
  }

  return <ScrollView
    style={styles.manager}
    contentContainerStyle={styles.managerContent}
    automaticallyAdjustKeyboardInsets
    keyboardDismissMode="interactive"
    keyboardShouldPersistTaps="handled"
  >
    <View style={styles.managementHeading}>
      <View style={styles.managementHeadingCopy}>
        <Text style={[styles.sectionTitle, { color: colors.text }]}>Saved servers</Text>
        <Text style={[styles.help, { color: colors.muted }]}>Switching replaces the active workspace without mixing server data.</Text>
      </View>
      <SecondaryButton icon={Plus} label="Add server" disabled={Boolean(busy)} onPress={openAdd} />
    </View>

    <View style={[styles.profileList, { borderColor: colors.border }]}>
      {profiles.length ? profiles.map((profile, index) => {
        const active = profile.id === activeProfileId
        const switching = profile.id === switchingProfileId || busy === `switch:${profile.id}`
        return <ServerManagementRow
          key={profile.id}
          profile={profile}
          index={index}
          count={profiles.length}
          active={active}
          switching={switching}
          disabled={Boolean(busy) || Boolean(switchingProfileId)}
          onSwitch={() => { void switchProfile(profile.id) }}
          onEdit={() => openEdit(profile)}
          onMove={direction => { void moveProfile(profile.id, direction) }}
          onRemove={() => confirmRemove(profile)}
        />
      }) : <View style={styles.noProfiles}>
        <Server size={24} color={colors.muted} />
        <Text style={[styles.noProfilesTitle, { color: colors.text }]}>No saved servers</Text>
        <Text style={[styles.help, { color: colors.muted, textAlign: 'center' }]}>Add and test a server connection to begin.</Text>
      </View>}
    </View>

    {feedback ? <View
      accessibilityRole="alert"
      style={[styles.feedback, {
        backgroundColor: feedback.tone === 'error' ? `${colors.red}18` : feedback.tone === 'success' ? `${colors.green}18` : colors.raised,
        borderColor: feedback.tone === 'error' ? `${colors.red}66` : feedback.tone === 'success' ? `${colors.green}66` : colors.border,
      }]}
    ><Text style={{ color: feedback.tone === 'error' ? colors.red : feedback.tone === 'success' ? colors.green : colors.text, fontSize: 12, lineHeight: 17 }}>{feedback.message}</Text></View> : null}

    {draft ? <View testID="server-profile-editor" style={[styles.editor, { backgroundColor: colors.raised, borderColor: colors.border }]}>
      <View style={styles.editorHeader}>
        <View style={styles.editorHeaderCopy}>
          <Text style={[styles.editorTitle, { color: colors.text }]}>{draft.profileId ? `Edit ${editedProfile?.name || 'server'}` : 'Add server'}</Text>
          <Text style={[styles.help, { color: colors.muted }]}>Credentials remain in the device secure store.</Text>
        </View>
        <IconButton icon={X} disabled={Boolean(busy)} onPress={closeEditor} label="Close server editor" />
      </View>

      <FieldLabel text="Name" />
      <TextInput
        testID="server-profile-name"
        accessibilityLabel="Server name"
        value={draft.name}
        onChangeText={name => updateDraft({ name })}
        editable={!busy}
        placeholder="Production, Home Mac, Lab…"
        placeholderTextColor={colors.muted}
        returnKeyType="next"
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />

      <FieldLabel text="Server address" />
      <TextInput
        testID="server-profile-url"
        accessibilityLabel="Server address"
        value={draft.serverUrl}
        onChangeText={serverUrl => updateDraft({ serverUrl }, true)}
        editable={!busy}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="server.example.com:7850"
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
      />

      <FieldLabel text="Access token" />
      <TextInput
        testID="server-profile-token"
        accessibilityLabel="Access token"
        value={draft.accessToken}
        onChangeText={accessToken => updateDraft({ accessToken }, true)}
        editable={!busy && !draft.clearAccessToken}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        placeholder={editedProfile?.hasAccessToken ? 'Leave blank to keep saved token' : 'Token from AgentsServer'}
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border, opacity: draft.clearAccessToken ? 0.4 : 1 }]}
      />
      {editedProfile?.hasAccessToken ? <View style={styles.switchRow}>
        <View style={styles.switchCopy}>
          <Text style={[styles.switchTitle, { color: colors.text }]}>Remove saved access token</Text>
          <Text style={[styles.help, { color: colors.muted }]}>Blank above preserves it; this switch explicitly deletes it.</Text>
        </View>
        <Switch
          testID="server-profile-clear-token"
          accessibilityLabel="Remove saved access token"
          value={draft.clearAccessToken}
          disabled={Boolean(busy)}
          onValueChange={clearAccessToken => updateDraft({ clearAccessToken, accessToken: '' }, true)}
        />
      </View> : null}

      {identityResetRequired ? <View style={[styles.identityWarning, { backgroundColor: `${colors.orange}14`, borderColor: `${colors.orange}55` }]}>
        <View style={styles.switchRow}>
          <View style={styles.switchCopy}>
            <Text style={[styles.switchTitle, { color: colors.orange }]}>Allow a new server identity</Text>
            <Text style={[styles.help, { color: colors.muted }]}>The endpoint no longer matches the saved identity. Confirm only after intentionally replacing or moving the server.</Text>
          </View>
          <Switch
            testID="server-profile-reset-identity"
            accessibilityLabel="Allow a new server identity"
            value={draft.resetServerIdentity}
            disabled={Boolean(busy)}
            onValueChange={confirmIdentityReset}
          />
        </View>
      </View> : null}

      {tested ? <View accessibilityRole="alert" style={[styles.testResult, { backgroundColor: `${duplicateProfile || testedIdentityChanged ? colors.orange : colors.green}18` }]}>
        <Check size={16} color={duplicateProfile || testedIdentityChanged ? colors.orange : colors.green} />
        <Text style={{ flex: 1, color: duplicateProfile || testedIdentityChanged ? colors.orange : colors.green, fontSize: 12, lineHeight: 17 }}>
          {duplicateProfile
            ? `Already saved as “${duplicateProfile.name}”.`
            : testedIdentityChanged
              ? `Connected, but this endpoint now reports ${tested.server_identity} instead of ${editedProfile?.serverIdentity}. Confirm the identity reset below before saving.`
            : `Connected${tested.server_identity ? ` · ${tested.server_identity}` : ''}${tested.version ? ` · ${tested.version}` : ''}`}
        </Text>
      </View> : null}

      {!draft.profileId && !tested ? <Text style={[styles.help, { color: colors.muted }]}>A successful connection test is required before this server can be added.</Text> : null}
      {draft.profileId && updateTestMissing ? <Text style={[styles.help, { color: colors.orange }]}>Test this exact connection before saving address, access-token, or identity changes.</Text> : null}

      <View style={styles.editorActions}>
        <SecondaryButton
          icon={Wifi}
          label={busy === 'test' ? 'Testing…' : 'Test connection'}
          disabled={Boolean(busy) || !draft.serverUrl.trim()}
          busy={busy === 'test'}
          onPress={() => { void testConnection() }}
        />
        <View style={styles.actionSpacer} />
        <SecondaryButton label="Cancel" disabled={Boolean(busy)} onPress={closeEditor} />
        <PrimaryButton
          label={busy === 'save' ? 'Saving…' : draft.profileId ? 'Save' : duplicateProfile ? `Use ${duplicateProfile.name}` : 'Add & switch'}
          disabled={Boolean(busy) || !draft.serverUrl.trim() || (!draft.profileId && !tested?.ok) || Boolean(draft.profileId && duplicateProfile) || updateTestMissing || identityResetUnconfirmed}
          busy={busy === 'save'}
          onPress={() => { void save() }}
        />
      </View>
    </View> : null}
  </ScrollView>
}

function ServerManagementRow({ profile, index, count, active, switching, disabled, onSwitch, onEdit, onMove, onRemove }: {
  profile: ServerProfileListItem
  index: number
  count: number
  active: boolean
  switching: boolean
  disabled: boolean
  onSwitch: () => void
  onEdit: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
}) {
  const colors = usePalette()
  const status = profileConnectionLabel(profile)
  const details = [profile.serverIdentity ? `Identity: ${profile.serverIdentity}` : '', profile.serverVersion ? `AgentsServer ${profile.serverVersion}` : ''].filter(Boolean).join(' · ')
  const actions: MenuAction[] = [
    { id: 'up', title: `Move ${profile.name} Up`, image: 'arrow.up', attributes: { disabled: disabled || index === 0 } },
    { id: 'down', title: `Move ${profile.name} Down`, image: 'arrow.down', attributes: { disabled: disabled || index === count - 1 } },
    {
      id: 'remove',
      title: active ? 'Active Server Cannot Be Removed' : `Remove ${profile.name}`,
      image: 'trash',
      attributes: { disabled: disabled || active, destructive: !active },
    },
  ]
  return <View style={[styles.profileRow, { borderColor: colors.border, backgroundColor: active ? `${colors.blue}10` : colors.surface }]}>
    <ServerConnectionDot state={switching ? 'connecting' : profile.connectionState} label={switching ? `Connecting to ${profile.name}` : status} />
    <View style={styles.profileCopy}>
      <View style={styles.profileTitleRow}>
        <Text style={[styles.profileName, { color: colors.text }]} numberOfLines={1}>{profile.name}</Text>
        {active ? <View style={[styles.activeBadge, { backgroundColor: `${colors.blue}20` }]}><Text style={[styles.activeBadgeText, { color: colors.blue }]}>Active</Text></View> : null}
        {profile.cachedUnreadCount > 0 ? <ServerUnreadBadge count={profile.cachedUnreadCount} /> : null}
      </View>
      <Text style={[styles.profileUrl, { color: colors.muted }]} numberOfLines={1}>{profile.serverUrl}</Text>
      {profile.lastConnectionError ? <Text style={[styles.profileDetail, { color: profile.connectionState === 'degraded' ? colors.orange : colors.red }]} numberOfLines={2}>{profile.lastConnectionError}</Text> : details ? <Text style={[styles.profileDetail, { color: colors.muted }]} numberOfLines={1}>{details}</Text> : null}
    </View>
    {!active ? <SecondaryButton label={switching ? 'Using…' : 'Use'} disabled={disabled} busy={switching} accessibilityLabel={`Use ${profile.name}`} compact onPress={onSwitch} /> : null}
    <IconButton icon={Pencil} disabled={disabled} onPress={onEdit} label={`Edit ${profile.name}`} />
    {disabled ? <View style={styles.rowMenu}><View
      accessible
      accessibilityRole="button"
      accessibilityLabel={`More actions for ${profile.name}`}
      accessibilityState={{ disabled: true }}
      style={[styles.moreButton, { opacity: 0.35 }]}
    ><MoreHorizontal size={19} color={colors.muted} /></View></View> : <MenuView
      title={profile.name}
      actions={actions}
      onPressAction={event => {
        if (event.nativeEvent.event === 'up') onMove(-1)
        else if (event.nativeEvent.event === 'down') onMove(1)
        else if (event.nativeEvent.event === 'remove') onRemove()
      }}
      style={styles.rowMenu}
    >
      <View
        accessible
        accessibilityRole="button"
        accessibilityLabel={`More actions for ${profile.name}`}
        style={styles.moreButton}
      ><MoreHorizontal size={19} color={colors.muted} /></View>
    </MenuView>}
  </View>
}

export function ServerConnectionDot({ state, label = connectionStateLabel(state) }: { state: ServerProfileConnectionState; label?: string }) {
  const colors = usePalette()
  const color = state === 'online' ? colors.green : state === 'degraded' || state === 'retrying' ? colors.orange : state === 'connecting' ? colors.blue : state === 'offline' ? colors.red : colors.muted
  return <View accessible accessibilityRole="image" accessibilityLabel={label} style={[styles.connectionDot, { backgroundColor: color }]} />
}

export function ServerUnreadBadge({ count }: { count: number }) {
  const colors = usePalette()
  return <View accessible accessibilityRole="text" accessibilityLabel={`${count} unread chat${count === 1 ? '' : 's'}`} style={[styles.unreadBadge, { backgroundColor: colors.blue }]}>
    <Text style={styles.unreadText}>{unreadCountLabel(count)}</Text>
  </View>
}

function FieldLabel({ text }: { text: string }) {
  const colors = usePalette()
  return <Text style={[styles.fieldLabel, { color: colors.muted }]}>{text}</Text>
}

function PrimaryButton({ label, disabled, busy, onPress }: { label: string; disabled?: boolean; busy?: boolean; onPress: () => void }) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.blue, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}
  >{busy ? <ActivityIndicator size="small" color="white" /> : null}<Text style={styles.primaryButtonText}>{label}</Text></Pressable>
}

function SecondaryButton({ icon: Icon, label, accessibilityLabel, disabled, busy, compact, onPress }: {
  icon?: typeof Plus
  label: string
  accessibilityLabel?: string
  disabled?: boolean
  busy?: boolean
  compact?: boolean
  onPress: () => void
}) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={accessibilityLabel ?? label}
    accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.secondaryButton, compact && styles.compactButton, { backgroundColor: colors.raised, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}
  >{busy ? <ActivityIndicator size="small" color={colors.blue} /> : Icon ? <Icon size={15} color={colors.muted} /> : null}{compact && busy ? null : <Text style={[styles.secondaryButtonText, { color: colors.text }]} numberOfLines={1}>{label}</Text>}</Pressable>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeComparableURL(value?: string): string {
  if (!value?.trim()) return ''
  try { return new URL(/^https?:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`).toString().replace(/\/$/, '') }
  catch { return value.trim() }
}

const styles = StyleSheet.create({
  selectorMenu: { minWidth: 0 },
  selector: { minHeight: 48, minWidth: 0, borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  selectorCopy: { flex: 1, minWidth: 0, gap: 1 },
  selectorName: { fontSize: 13, fontWeight: '800' },
  selectorHost: { fontSize: 10 },
  connectionDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  unreadBadge: { minWidth: 21, minHeight: 20, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center', justifyContent: 'center' },
  unreadText: { color: 'white', fontSize: 10, fontWeight: '800' },
  sheet: { flex: 1 },
  sheetSafeArea: { flex: 1 },
  grabber: { alignSelf: 'center', width: 36, height: 5, marginTop: 7, marginBottom: 1, borderRadius: 3, backgroundColor: '#8a8a8a88' },
  sheetHeader: { minHeight: 64, paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8 },
  sheetHeadingCopy: { flex: 1, minWidth: 0, gap: 2 },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  sheetSubtitle: { fontSize: 10 },
  manager: { flex: 1 },
  managerContent: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: 14, paddingBottom: 28, gap: 10 },
  managementHeading: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10 },
  managementHeadingCopy: { flex: 1, minWidth: 0, gap: 3 },
  sectionTitle: { fontSize: 14, fontWeight: '800' },
  help: { fontSize: 11, lineHeight: 16 },
  profileList: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, overflow: 'hidden' },
  profileRow: { minHeight: 68, paddingVertical: 8, paddingLeft: 11, paddingRight: 5, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 8 },
  profileCopy: { flex: 1, minWidth: 74, gap: 2 },
  profileTitleRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 6 },
  profileName: { minWidth: 0, flexShrink: 1, fontSize: 13, fontWeight: '800' },
  profileUrl: { fontSize: 10 },
  profileDetail: { fontSize: 9, lineHeight: 13 },
  activeBadge: { minHeight: 18, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center', justifyContent: 'center' },
  activeBadgeText: { fontSize: 8, fontWeight: '800', textTransform: 'uppercase' },
  rowMenu: { width: 44, height: 44 },
  moreButton: { width: 44, height: 44, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  noProfiles: { minHeight: 150, padding: 20, alignItems: 'center', justifyContent: 'center', gap: 7 },
  noProfilesTitle: { fontSize: 15, fontWeight: '800' },
  feedback: { minHeight: 42, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, padding: 10, justifyContent: 'center' },
  editor: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  editorHeader: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 8 },
  editorHeaderCopy: { flex: 1, minWidth: 0, gap: 2 },
  editorTitle: { fontSize: 14, fontWeight: '800' },
  fieldLabel: { marginTop: 2, fontSize: 11, fontWeight: '700' },
  input: { minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, fontSize: 14 },
  switchRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchCopy: { flex: 1, minWidth: 0, gap: 2 },
  switchTitle: { fontSize: 12, fontWeight: '700' },
  identityWarning: { borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 2 },
  testResult: { minHeight: 42, borderRadius: 6, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  editorActions: { paddingTop: 3, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: 7 },
  actionSpacer: { flex: 1, minWidth: 8 },
  primaryButton: { minHeight: 44, borderRadius: 6, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  primaryButtonText: { color: 'white', fontSize: 12, fontWeight: '800' },
  secondaryButton: { minHeight: 44, borderRadius: 6, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  compactButton: { minWidth: 55, paddingHorizontal: 9 },
  secondaryButtonText: { fontSize: 12, fontWeight: '700' },
})
