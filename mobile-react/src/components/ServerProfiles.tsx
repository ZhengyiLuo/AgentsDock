import { useEffect, useMemo, useRef, useState } from 'react'
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
import { ScreenStack, ScreenStackItem } from 'react-native-screens'
import { MenuView, type MenuAction } from '@expo/ui/community/menu'
import { SafeAreaView } from 'react-native-safe-area-context'
import Svg, { Circle, Text as SvgText } from 'react-native-svg'
import { ArrowLeft, Check, ChevronDown, MoreHorizontal, Plus, ScanLine, Server, Wifi } from 'lucide-react-native'
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
import { fontWeight, radius, spacing, typography, usePalette } from '../theme'
import { dismissAppKeyboard } from '../lib/app-keyboard'
import { Text, TextInput } from './AppText'
import { IconButton, SheetCloseButton } from './ui'
import { ServerQrScanner } from './ServerQrScanner'
import type { ServerConnectionDetails } from '../lib/server-connection-link'
import { selectServerAddress } from '../lib/server-address-selection'
import { t } from '../i18n'

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
const serverSheetDetents = [0.5, 1]
const scannerSheetDetents = [1]

interface CommonServerProfileProps {
  profiles: readonly ServerProfileListItem[]
  activeProfileId: string | null
  switchingProfileId?: string | null
}

export interface ServerProfileSelectorProps extends CommonServerProfileProps {
  disabled?: boolean
  refreshing?: boolean
  onPress: () => void
}

export interface ServerProfilesManagerProps extends CommonServerProfileProps {
  initialMode?: ServerProfileEditorInitialMode
  onSwitchProfile: (profileId: string) => Awaitable<ActionResult>
  onTestConnection: (input: ServerProfileTestInput) => Awaitable<ServerConnectionTestResult>
  onCreateProfile: (input: CreateServerProfileInput) => Awaitable<CreatedProfile>
  onUpdateProfile: (profileId: string, patch: UpdateServerProfileInput) => Awaitable<void>
  onRemoveProfile: (profileId: string) => Awaitable<void>
  onSelected?: () => void
  onClose?: () => void
  onScannerVisibilityChange?: (visible: boolean) => void
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
  refreshing = false,
  onPress,
}: ServerProfileSelectorProps) {
  const colors = usePalette()
  const active = profiles.find(profile => profile.id === activeProfileId) ?? profiles[0] ?? null
  const switching = profiles.find(profile => profile.id === switchingProfileId) ?? null
  const unavailable = disabled || Boolean(switchingProfileId)
  const selectorLabel = switching
    ? `Switching to ${switching.name}. Please wait.`
    : active
      ? `${active.name}, ${profileConnectionLabel(active)}${active.cachedUnreadCount > 0 ? `, ${active.cachedUnreadCount} unread` : ''}. Choose agent server.`
      : 'Choose agent server'
  return <Pressable
    testID="server-profile-selector"
    accessible
    accessibilityRole="button"
    accessibilityLabel={`${t(selectorLabel)}${refreshing ? ` ${t('Refreshing chats.')}` : ''}`}
    accessibilityState={{ disabled: unavailable, expanded: false, busy: Boolean(switchingProfileId) || refreshing }}
    disabled={unavailable}
    onPress={onPress}
    style={({ pressed }) => [styles.selector, { borderColor: colors.controlBorder, backgroundColor: pressed ? colors.raised : colors.controlSurface, opacity: unavailable ? 0.4 : 1 }]}
  >
    <ServerConnectionDot state={switching?.connectionState ?? active?.connectionState ?? 'cached'} label={switching ? `Connecting to ${switching.name}` : active ? profileConnectionLabel(active) : 'No server selected'} />
    <Text style={[styles.selectorName, { color: colors.text }]} numberOfLines={1} ellipsizeMode="tail">{switching?.name || active?.name || t('Choose server')}</Text>
    <View style={styles.selectorRefresh} pointerEvents="none">
      {refreshing ? <ActivityIndicator testID="server-chat-refresh" accessibilityLabel="Refreshing chats" size="small" color={colors.muted} /> : <ChevronDown size={14} color={colors.muted} />}
    </View>
  </Pressable>
}

export function ServerProfilesSheet({ visible, onClose, ...props }: ServerProfilesSheetProps) {
  const colors = usePalette()
  const [scannerVisible, setScannerVisible] = useState(false)
  useEffect(() => { if (!visible) setScannerVisible(false) }, [visible])
  // Android formSheet can desynchronize touch coordinates after keyboard/scroll
  // transitions. Keep the same editor in a resizable native Modal instead.
  if (Platform.OS === 'android') {
    return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.androidBackdrop}>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Close server management')} style={StyleSheet.absoluteFill} onPress={onClose} />
        <SafeAreaView testID="server-profiles-android-sheet" edges={['bottom']}
          style={[styles.androidSheet, { backgroundColor: colors.surface }]}>
          {visible ? <ServerProfilesManager {...props} onSelected={onClose} onClose={onClose} /> : null}
        </SafeAreaView>
      </View>
    </Modal>
  }
  // Keep the native presenter alive through dismissal, but never intercept home touches when closed.
  return <View style={StyleSheet.absoluteFill} pointerEvents={visible ? 'box-none' : 'none'}>
    <ScreenStack style={styles.sheet}>
      <ScreenStackItem screenId="servers-anchor" activityState={2} headerConfig={{ hidden: true }} pointerEvents="none" style={styles.sheet} />
      {visible ? <ScreenStackItem
        screenId="servers-drawer"
        activityState={2}
        stackPresentation="formSheet"
        sheetAllowedDetents={scannerVisible ? scannerSheetDetents : serverSheetDetents}
        sheetInitialDetentIndex={0}
        sheetGrabberVisible
        sheetExpandsWhenScrolledToEdge
        headerConfig={{ hidden: true }}
        contentStyle={{ backgroundColor: colors.surface }}
        onDismissed={onClose}
        style={styles.sheet}
      >
        <SafeAreaView style={styles.sheetSafeArea} edges={['bottom']}>
          <ServerProfilesManager {...props} onSelected={onClose} onClose={onClose} onScannerVisibilityChange={setScannerVisible} />
        </SafeAreaView>
      </ScreenStackItem> : null}
    </ScreenStack>
  </View>
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
  onRemoveProfile,
  onSelected,
  onClose,
  onScannerVisibilityChange,
}: ServerProfilesManagerProps) {
  const colors = usePalette()
  const [draft, setDraft] = useState<ServerProfileDraftValues | null>(() => initialServerProfileDraft(initialMode, profiles, activeProfileId))
  const [busy, setBusy] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [entryMethod, setEntryMethod] = useState<'manual' | 'qr'>('manual')
  useEffect(() => { onScannerVisibilityChange?.(scanning) }, [onScannerVisibilityChange, scanning])
  const [qrIdentity, setQrIdentity] = useState<string | null>(null)
  const [tested, setTested] = useState<ServerConnectionTestResult | null>(null)
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'success' | 'neutral'; message: string } | null>(null)
  const testLease = useRef(0)
  const testController = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; testLease.current += 1; testController.current?.abort() }
  }, [])
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
    testController.current?.abort()
    setTested(null)
    setFeedback(null)
    if (busy === 'test') setBusy(null)
  }
  const updateDraft = (patch: Partial<ServerProfileDraftValues>, invalidatesTest = false) => {
    if (invalidatesTest) invalidateTest()
    setDraft(current => current ? { ...current, ...(patch.serverUrl !== undefined ? { serverUrls: undefined } : {}), ...patch } : current)
  }
  const openAdd = () => {
    if (busy) return
    invalidateTest()
    setQrIdentity(null)
    setEntryMethod('manual')
    setDraft(emptyServerProfileDraft())
  }
  const openEdit = (profile: ServerProfileListItem) => {
    if (busy) return
    invalidateTest()
    setQrIdentity(null)
    setEntryMethod('manual')
    setDraft(editServerProfileDraft(profile))
  }
  const closeEditor = () => {
    if (busy) return
    if (scanning) { setScanning(false); return }
    invalidateTest()
    setQrIdentity(null)
    setDraft(null)
    dismissAppKeyboard()
  }

  const testConnection = async (candidate = draft, expectedIdentity = qrIdentity) => {
    if (!candidate?.serverUrl.trim()) return
    dismissAppKeyboard()
    const request = ++testLease.current
    testController.current?.abort()
    const controller = new AbortController()
    testController.current = controller
    const testedDraft = { ...candidate }
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
      const selected = testedDraft.serverUrls && expectedIdentity
        ? await selectServerAddress(testedDraft.serverUrls, expectedIdentity,
          (serverUrl, signal) => Promise.resolve(onTestConnection({ ...input, serverUrl, signal, timeoutMs: 5000 })),
          { signal: controller.signal })
        : { serverURL: testedDraft.serverUrl, health: await onTestConnection({ ...input, signal: controller.signal }) }
      const result = selected.health
      if (result.ok !== true) throw new Error(result.message || 'Server health check reported unavailable.')
      if (!result.server_identity?.trim()) throw new Error('This AgentsServer did not report a stable server identity.')
      if (expectedIdentity && result.server_identity !== expectedIdentity) throw new Error('This server does not match the scanned QR. Generate a fresh QR on the intended server.')
      if (request === testLease.current) {
        setDraft(current => current ? { ...current, serverUrl: selected.serverURL } : current)
        setTested(result)
      }
    } catch (error) {
      if (request === testLease.current) setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      if (request === testLease.current) setBusy(null)
    }
  }

  const acceptQr = (details: ServerConnectionDetails) => {
    const candidate = { ...emptyServerProfileDraft(), name: details.name, serverUrl: details.serverUrl, serverUrls: details.serverUrls, accessToken: details.accessToken }
    setScanning(false)
    setEntryMethod('qr')
    setQrIdentity(details.serverIdentity)
    setDraft(candidate)
    void testConnection(candidate, details.serverIdentity)
  }

  const switchProfile = async (profileId: string) => {
    if (switchingProfileId || busy) return
    if (profileId === activeProfileId) {
      onSelected?.()
      return
    }
    setBusy(`switch:${profileId}`)
    setFeedback(null)
    try {
      const switched = await onSwitchProfile(profileId)
      if (switched === false) throw new Error('The requested server was not activated.')
      if (mounted.current) onSelected?.()
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
        if (draft.serverUrls) {
          // Reuse the saved credential; the store validates it before updating addresses.
          await onUpdateProfile(duplicateProfile.id, { serverUrl: draft.serverUrl, serverUrls: draft.serverUrls, serverIdentity: tested!.server_identity! })
        }
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
      if (!draft.profileId && mounted.current) onSelected?.()
    } catch (error) {
      setFeedback({ tone: 'error', message: errorMessage(error) })
    } finally {
      setBusy(null)
    }
  }

  const removeProfile = async (profile: ServerProfileListItem) => {
    if (busy) return
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
    if (busy) return
    Alert.alert(
      t('Remove “{name}”?', { name: profile.name }),
      t('Only this saved connection will be removed. This will not stop tasks or delete chats on the server. Cached chats remain on this device.'),
      [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Remove server'), style: 'destructive', onPress: () => { void removeProfile(profile) } },
      ],
    )
  }

  const confirmIdentityReset = (enabled: boolean) => {
    if (!enabled) {
      updateDraft({ resetServerIdentity: false })
      return
    }
    Alert.alert(
      t('Trust a new server identity?'),
      t('Only continue if you intentionally replaced or moved this AgentsServer. The previous cached workspace will be preserved.'),
      [
        { text: t('Cancel'), style: 'cancel' },
        { text: t('Allow identity reset'), style: 'destructive', onPress: () => updateDraft({ resetServerIdentity: true }) },
      ],
    )
  }

  const feedbackNotice = feedback ? <View
    testID="server-profile-feedback"
    accessibilityRole="alert"
    accessibilityLiveRegion="polite"
    style={[styles.feedback, {
      backgroundColor: feedback.tone === 'error' ? `${colors.red}18` : feedback.tone === 'success' ? `${colors.green}18` : colors.raised,
      borderColor: feedback.tone === 'error' ? `${colors.red}66` : feedback.tone === 'success' ? `${colors.green}66` : colors.border,
    }]}
  ><Text style={[typography.caption, { color: feedback.tone === 'error' ? colors.red : feedback.tone === 'success' ? colors.green : colors.text }]}>{t(feedback.message)}</Text></View> : null

  return <>
    <View style={[styles.sheetHeader, { borderColor: colors.border }]}>
      {draft ? <IconButton icon={ArrowLeft} disabled={Boolean(busy)} onPress={closeEditor} label={scanning ? 'Back to add server' : 'Back to servers'} testID="server-editor-back" /> : null}
      <View style={styles.sheetHeadingCopy}>
        <Text testID="server-management-title" accessibilityRole="header" style={[styles.sheetTitle, { color: colors.text }]} numberOfLines={1}>{t(scanning ? 'Scan QR code' : draft ? draft.profileId ? 'Edit server' : 'Add server' : 'Servers')}</Text>
      </View>
      {onClose ? <SheetCloseButton onPress={onClose} label="Close server management" testID="server-management-close" /> : null}
    </View>
    {/* The native form sheet resizes for the keyboard; a second adjustment scrolls past the focused input. */}
    <ScrollView
    style={styles.manager}
    contentContainerStyle={styles.managerContent}
    automaticallyAdjustKeyboardInsets={false}
    keyboardDismissMode={Platform.OS === 'android' ? 'on-drag' : 'interactive'}
    keyboardShouldPersistTaps="handled"
  >
    {!draft ? <View testID="server-profile-list">
      {profiles.length ? profiles.map(profile => {
        const active = profile.id === activeProfileId
        const switching = profile.id === switchingProfileId || busy === `switch:${profile.id}`
        return <ServerManagementRow
          key={profile.id}
          profile={profile}
          active={active}
          switching={switching}
          disabled={Boolean(busy) || Boolean(switchingProfileId)}
          onSwitch={() => { void switchProfile(profile.id) }}
          onEdit={() => openEdit(profile)}
          onRemove={() => confirmRemove(profile)}
        />
      }) : <View style={styles.noProfiles}>
        <Server size={24} color={colors.muted} />
        <Text style={[styles.noProfilesTitle, { color: colors.text }]} localize>No saved servers</Text>
      </View>}
      <Pressable
        testID="server-profile-add"
        accessibilityRole="button"
        accessibilityLabel="Add server"
        disabled={Boolean(busy) || Boolean(switchingProfileId)}
        onPress={openAdd}
        style={({ pressed }) => [styles.addServer, { opacity: busy || switchingProfileId ? 0.35 : pressed ? 0.65 : 1 }]}
      ><Plus size={20} color={colors.text} /><Text style={[styles.profileName, { color: colors.text }]} localize>Add server</Text></Pressable>
    </View> : null}

    {!draft ? feedbackNotice : null}

    {scanning ? <ServerQrScanner onScanned={acceptQr} /> : draft ? <View testID="server-profile-editor" style={styles.editor}>
      {!draft.profileId ? <SecondaryButton icon={ScanLine} label="Scan QR code" disabled={Boolean(busy)} onPress={() => {
        dismissAppKeyboard()
        invalidateTest()
        setScanning(true)
      }} /> : null}
      {!draft.profileId && entryMethod === 'manual' ? <Text style={[typography.caption, styles.manualCaption, { color: colors.muted }]} localize>or add manually</Text> : null}
      {!draft.profileId && entryMethod === 'qr' ? <>
        <View testID="server-scanned-summary" style={styles.scannedSummary}>
          {draft.name ? <Text style={[typography.label, { color: colors.text }]}>{draft.name}</Text> : null}
          <Text selectable style={[typography.body, { color: colors.muted }]}>{draft.serverUrl}</Text>
        </View>
        <Pressable testID="server-manual-entry" accessibilityRole="button" accessibilityLabel="Edit details"
          disabled={Boolean(busy)} onPress={() => setEntryMethod('manual')}
          style={({ pressed }) => [styles.manualEntry, { opacity: busy ? 0.35 : pressed ? 0.65 : 1 }]}>
          <Text style={[typography.body, { color: colors.blue }]} localize>Edit details</Text>
        </Pressable>
      </> : null}
      {entryMethod === 'manual' ? <View style={styles.editorFields}>
        <View style={styles.editorField}>
          <FieldLabel step={1} text="Name (optional)" />
          <TextInput
            testID="server-profile-name"
            accessibilityLabel="Server name (optional)"
            value={draft.name}
            onChangeText={name => updateDraft({ name })}
            editable={!busy}
            placeholder="e.g. Home Mac"
            placeholderTextColor={colors.muted}
            returnKeyType="next"
            style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
          />
        </View>

        <View style={styles.editorField}>
          <FieldLabel step={2} text="Server URL" />
          <TextInput
            testID="server-profile-url"
            accessibilityLabel="Server address"
            value={draft.serverUrl}
            onChangeText={serverUrl => updateDraft({ serverUrl }, true)}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://server.example.com:7850"
            placeholderTextColor={colors.muted}
            style={[styles.input, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
          />
        </View>

        <View style={styles.editorField}>
          <FieldLabel step={3} text="Access token" />
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
        </View>
      </View> : null}
      {editedProfile?.hasAccessToken ? <View style={styles.switchRow}>
        <View style={styles.switchCopy}>
          <Text style={[styles.switchTitle, { color: colors.text }]} localize>Remove saved access token</Text>
          <Text style={[styles.help, { color: colors.muted }]} localize>Blank above preserves it; this switch explicitly deletes it.</Text>
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
            <Text style={[styles.switchTitle, { color: colors.orange }]} localize>Allow a new server identity</Text>
            <Text style={[styles.help, { color: colors.muted }]} localize>The endpoint no longer matches the saved identity. Confirm only after intentionally replacing or moving the server.</Text>
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

      {feedbackNotice}
      {tested ? <View testID="server-profile-test-result" accessibilityRole="alert" style={[styles.testResult, { backgroundColor: `${duplicateProfile || testedIdentityChanged ? colors.orange : colors.green}18` }]}>
        <Check size={16} color={duplicateProfile || testedIdentityChanged ? colors.orange : colors.green} />
        <Text style={[typography.caption, { flex: 1, color: duplicateProfile || testedIdentityChanged ? colors.orange : colors.green }]}>
          {duplicateProfile
            ? t('Already saved as “{name}”.', { name: duplicateProfile.name })
            : testedIdentityChanged
              ? t('Connected, but this endpoint now reports {actual} instead of {saved}. Confirm the identity reset below before saving.', { actual: tested.server_identity ?? '', saved: editedProfile?.serverIdentity ?? '' })
            : `${t('Connected')}${tested.server_identity ? ` · ${tested.server_identity}` : ''}${tested.version ? ` · ${tested.version}` : ''}`}
        </Text>
      </View> : null}

      {!draft.profileId && !tested ? <Text style={[styles.help, { color: colors.muted }]} localize>A successful connection test is required before this server can be added.</Text> : null}
      {draft.profileId && updateTestMissing ? <Text style={[styles.help, { color: colors.orange }]} localize>Test this exact connection before saving address, access-token, or identity changes.</Text> : null}

      <View style={styles.editorActions}>
        <SecondaryButton
          testID="server-profile-test"
          icon={Wifi}
          label={busy === 'test' ? 'Testing…' : 'Test connection'}
          disabled={Boolean(busy) || !draft.serverUrl.trim()}
          busy={busy === 'test'}
          onPress={() => { void testConnection() }}
        />
        <View style={styles.actionSpacer} />
        <PrimaryButton
          label={busy === 'save' ? 'Saving…' : draft.profileId ? 'Save' : duplicateProfile ? t('Use {name}', { name: duplicateProfile.name }) : 'Add'}
          disabled={Boolean(busy) || !draft.serverUrl.trim() || (!draft.profileId && !tested?.ok) || Boolean(draft.profileId && duplicateProfile) || updateTestMissing || identityResetUnconfirmed}
          busy={busy === 'save'}
          onPress={() => { void save() }}
        />
      </View>
    </View> : null}
  </ScrollView>
  </>
}

function ServerManagementRow({ profile, active, switching, disabled, onSwitch, onEdit, onRemove }: {
  profile: ServerProfileListItem
  active: boolean
  switching: boolean
  disabled: boolean
  onSwitch: () => void
  onEdit: () => void
  onRemove: () => void
}) {
  const colors = usePalette()
  const status = profileConnectionLabel(profile)
  const actions: MenuAction[] = [
    { id: 'edit', title: t('Edit'), image: 'pencil', attributes: { disabled } },
    {
      id: 'remove',
      title: t('Remove'),
      image: 'trash',
      attributes: { disabled, destructive: true },
    },
  ]
  return <View style={[styles.profileRow, { borderColor: colors.border }]}>
    <Pressable
      testID={`server-profile-switch-${profile.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Use ${profile.name}`}
      accessibilityHint={t(status)}
      accessibilityState={{ selected: active, disabled, busy: switching }}
      disabled={disabled}
      onPress={onSwitch}
      style={({ pressed }) => [styles.profileSwitch, { backgroundColor: pressed ? colors.raised : 'transparent', opacity: disabled && !switching ? 0.5 : 1 }]}
    >
    <ServerConnectionDot state={profile.connectionState} label={switching ? t('Connecting to {name}', { name: profile.name }) : t(status)} />
    <View style={styles.profileCopy}>
      <View style={styles.profileTitleRow}>
        <Text style={[styles.profileName, { color: colors.text }]} numberOfLines={1}>{profile.name}</Text>
        {profile.cachedUnreadCount > 0 ? <ServerUnreadBadge count={profile.cachedUnreadCount} /> : null}
      </View>
      <Text style={[styles.profileUrl, { color: colors.muted }]} numberOfLines={1}>{profile.serverUrl}</Text>
      {profile.lastConnectionError ? <Text style={[styles.profileDetail, { color: profile.connectionState === 'degraded' ? colors.orange : colors.red }]} numberOfLines={2}>{profile.lastConnectionError}</Text> : null}
    </View>
    <View style={styles.profileSelection}>{switching ? <ActivityIndicator size="small" color={colors.muted} /> : active ? <Check size={20} color={colors.green} /> : null}</View>
    </Pressable>
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
        if (event.nativeEvent.event === 'edit') onEdit()
        else if (event.nativeEvent.event === 'remove') onRemove()
      }}
      style={styles.rowMenu}
    >
      <View
        testID={`server-profile-actions-${profile.id}`}
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
  const color = state === 'online' || state === 'degraded' ? colors.green : colors.muted
  return <View accessible accessibilityRole="image" accessibilityLabel={t(label)} style={[styles.connectionDot, { backgroundColor: color }]} />
}

export function ServerUnreadBadge({ count }: { count: number }) {
  const colors = usePalette()
  return <View accessible accessibilityRole="text" accessibilityLabel={`${count} unread chat${count === 1 ? '' : 's'}`} style={[styles.unreadBadge, { backgroundColor: colors.blue }]}>
    <Text style={[styles.unreadText, { color: colors.onAccent }]}>{unreadCountLabel(count)}</Text>
  </View>
}

function FieldLabel({ step, text }: { step: 1 | 2 | 3; text: string }) {
  const colors = usePalette()
  return <View testID={`server-profile-step-${step}`} accessible accessibilityRole="text" accessibilityLabel={`${step}. ${t(text)}`} style={styles.fieldHeading}>
    {/* Draw the badge in one fixed viewport, independent of native rounded-view layers. */}
    <Svg width={24} height={24} viewBox="0 0 24 24" preserveAspectRatio="xMidYMid meet" style={styles.fieldStep} accessible={false}>
      <Circle cx={12} cy={12} r={11.5} stroke={colors.blue} strokeWidth={1} fill={colors.blue} fillOpacity={0.06} />
      <SvgText x={12} y={16} textAnchor="middle" fontSize={typography.caption.fontSize} fontWeight={fontWeight.semibold} fill={colors.blue}>{step}</SvgText>
    </Svg>
    <Text style={[styles.fieldLabel, { color: colors.muted }]}>{t(text)}</Text>
  </View>
}

function PrimaryButton({ label, disabled, busy, onPress }: { label: string; disabled?: boolean; busy?: boolean; onPress: () => void }) {
  const colors = usePalette()
  return <Pressable
    accessibilityRole="button"
    accessibilityLabel={t(label)}
    accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.blue, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}
  >{busy ? <ActivityIndicator size="small" color={colors.onAccent} /> : null}<Text style={[styles.primaryButtonText, { color: colors.onAccent }]}>{t(label)}</Text></Pressable>
}

function SecondaryButton({ icon: Icon, label, accessibilityLabel, disabled, busy, compact, onPress, testID }: {
  testID?: string
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
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={t(accessibilityLabel ?? label)}
    accessibilityState={{ disabled: Boolean(disabled), busy: Boolean(busy) }}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.secondaryButton, compact && styles.compactButton, { backgroundColor: colors.raised, opacity: disabled ? 0.35 : pressed ? 0.65 : 1 }]}
  >{busy ? <ActivityIndicator size="small" color={colors.blue} /> : Icon ? <Icon size={15} color={colors.muted} /> : null}{compact && busy ? null : <Text style={[styles.secondaryButtonText, { color: colors.text }]} numberOfLines={1}>{t(label)}</Text>}</Pressable>
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
  selector: { minHeight: 44, minWidth: 0, maxWidth: '100%', alignSelf: 'flex-start', borderRadius: radius.round, borderWidth: 1, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  selectorName: { ...typography.label, flexShrink: 1, minWidth: 0, fontWeight: fontWeight.semibold },
  selectorRefresh: { width: 20, height: 20, flexShrink: 0, alignItems: 'center', justifyContent: 'center' },
  connectionDot: { width: 8, height: 8, borderRadius: radius.round, flexShrink: 0 },
  unreadBadge: { minWidth: 21, minHeight: 20, borderRadius: radius.round, paddingHorizontal: 6, paddingVertical: 2, alignItems: 'center', justifyContent: 'center' },
  unreadText: { ...typography.caption, fontWeight: fontWeight.semibold },
  sheet: { flex: 1 },
  androidBackdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: '#00000066' },
  androidSheet: { height: '90%', width: '100%', maxWidth: 760, alignSelf: 'center', borderTopLeftRadius: radius.md, borderTopRightRadius: radius.md, overflow: 'hidden' },
  sheetSafeArea: { flex: 1 },
  sheetHeader: { minHeight: 64, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sheetHeadingCopy: { flex: 1, minWidth: 0 },
  sheetTitle: { ...typography.title, fontWeight: fontWeight.semibold },
  manager: { flex: 1 },
  managerContent: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: spacing.lg, paddingBottom: spacing.xl, gap: spacing.lg },
  help: { ...typography.caption },
  profileRow: { minHeight: 68, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  profileSwitch: { flex: 1, minWidth: 0, minHeight: 68, paddingVertical: spacing.md, paddingHorizontal: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  profileSelection: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  addServer: { minHeight: 60, paddingHorizontal: spacing.xs, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  profileCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
  profileTitleRow: { minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  profileName: { ...typography.body, minWidth: 0, flexShrink: 1, fontWeight: fontWeight.semibold },
  profileUrl: { ...typography.caption },
  profileDetail: { ...typography.caption },
  rowMenu: { width: 44, height: 44 },
  moreButton: { width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  noProfiles: { minHeight: 150, padding: spacing.xl, alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  noProfilesTitle: { ...typography.body, fontWeight: fontWeight.semibold },
  feedback: { minHeight: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: spacing.md, justifyContent: 'center' },
  editor: { gap: spacing.sm },
  manualCaption: { textAlign: 'center', paddingVertical: spacing.sm },
  manualEntry: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  scannedSummary: { gap: spacing.xs, paddingTop: spacing.lg },
  editorFields: { gap: spacing.xl },
  editorField: { gap: spacing.sm },
  fieldHeading: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  fieldStep: { width: 24, height: 24, flexGrow: 0, flexShrink: 0 },
  fieldLabel: { ...typography.label, flex: 1, fontWeight: fontWeight.semibold },
  input: { ...typography.body, minHeight: 44, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  switchRow: { minHeight: 54, flexDirection: 'row', alignItems: 'center', gap: 10 },
  switchCopy: { flex: 1, minWidth: 0, gap: 2 },
  switchTitle: { ...typography.label, fontWeight: fontWeight.semibold },
  identityWarning: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 2 },
  testResult: { minHeight: 42, borderRadius: radius.md, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  editorActions: { paddingTop: spacing.xs, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm },
  actionSpacer: { flex: 1, minWidth: 8 },
  primaryButton: { minHeight: 44, borderRadius: radius.md, paddingHorizontal: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  primaryButtonText: { ...typography.label, fontWeight: fontWeight.semibold },
  secondaryButton: { minHeight: 44, borderRadius: radius.md, paddingHorizontal: spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  compactButton: { minWidth: 55, paddingHorizontal: 9 },
  secondaryButtonText: { ...typography.label, fontWeight: fontWeight.semibold },
})
