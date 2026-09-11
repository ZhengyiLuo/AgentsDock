import { useEffect } from 'react'
import { AppState, Linking, Platform, Pressable, StyleSheet, View } from 'react-native'
import { Download, ExternalLink, RefreshCw, ShieldCheck, X } from 'lucide-react-native'
import { useAndroidUpdaterStore } from '../store/useAndroidUpdaterStore'
import { usePalette } from '../theme'
import { Text } from './AppText'

export function AndroidUpdateCoordinator() {
  const channel = useAndroidUpdaterStore(state => state.channel)
  const stage = useAndroidUpdaterStore(state => state.stage)
  const update = useAndroidUpdaterStore(state => state.update)
  const dismissedVersionCode = useAndroidUpdaterStore(state => state.dismissedVersionCode)
  const progress = useAndroidUpdaterStore(state => state.downloadPercent)
  const error = useAndroidUpdaterStore(state => state.error)
  const check = useAndroidUpdaterStore(state => state.check)
  const install = useAndroidUpdaterStore(state => state.install)
  const resumeAfterPermission = useAndroidUpdaterStore(state => state.resumeAfterPermission)
  const dismissBanner = useAndroidUpdaterStore(state => state.dismissBanner)
  const colors = usePalette()

  useEffect(() => {
    if (Platform.OS !== 'android') return
    const timer = setTimeout(() => { void check(false) }, 4_000)
    const subscription = AppState.addEventListener('change', next => {
      if (next === 'active') void resumeAfterPermission()
    })
    return () => { clearTimeout(timer); subscription.remove() }
  }, [check, resumeAfterPermission])

  if (channel !== 'sideload' || !update || dismissedVersionCode === update.versionCode || !['available', 'downloading', 'verifying', 'permission', 'installer', 'error'].includes(stage)) return null
  const busy = stage === 'downloading' || stage === 'verifying'
  const title = stage === 'downloading'
    ? `Downloading Android beta · ${progress}%`
    : stage === 'verifying'
      ? 'Verifying Android beta…'
      : stage === 'permission'
        ? 'Allow AgentsDock to install this update'
        : stage === 'installer'
          ? 'Verified APK sent to Android installer'
          : stage === 'error'
            ? 'Android update needs attention'
            : `Android ${releaseLabel(update.tagName)} available`
  const detail = error ?? (stage === 'permission'
    ? 'Enable “Allow from this source,” then return to continue.'
    : `Signed build ${update.versionCode} can update this installation in place.`)
  return <View testID="android-update-banner" style={styles.bannerSlot}>
    <View style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.blue }]}>
      <Download size={18} color={colors.blue} />
      <View style={styles.bannerCopy}>
        <Text style={[styles.bannerTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.caption, { color: error ? colors.red : colors.muted }]} numberOfLines={2}>{detail}</Text>
      </View>
      {stage === 'permission'
        ? <SmallButton label="Continue" onPress={() => void resumeAfterPermission(true)} primary />
        : stage === 'installer'
          ? null
          : <SmallButton label={stage === 'error' ? 'Retry' : busy ? `${progress}%` : 'Update'} disabled={busy} onPress={() => void install()} primary />}
      <Pressable testID="android-update-later" accessibilityRole="button" accessibilityLabel="Remind me later" onPress={() => void dismissBanner()} style={styles.iconButton}>
        <X size={17} color={colors.muted} />
      </Pressable>
    </View>
  </View>
}

export function AndroidUpdateSettings() {
  const channel = useAndroidUpdaterStore(state => state.channel)
  const stage = useAndroidUpdaterStore(state => state.stage)
  const update = useAndroidUpdaterStore(state => state.update)
  const progress = useAndroidUpdaterStore(state => state.downloadPercent)
  const error = useAndroidUpdaterStore(state => state.error)
  const nativeState = useAndroidUpdaterStore(state => state.nativeState)
  const check = useAndroidUpdaterStore(state => state.check)
  const install = useAndroidUpdaterStore(state => state.install)
  const resumeAfterPermission = useAndroidUpdaterStore(state => state.resumeAfterPermission)
  const colors = usePalette()

  useEffect(() => {
    if (Platform.OS === 'android' && channel === 'unknown') void check(false)
  }, [channel, check])
  if (Platform.OS !== 'android') return null

  const busy = stage === 'checking' || stage === 'downloading' || stage === 'verifying'
  const status = updateStatusText(channel, stage, update?.tagName, update?.versionCode, progress)
  const action = stage === 'permission'
    ? { label: 'Continue installation', run: () => resumeAfterPermission(true) }
    : update
      ? { label: stage === 'downloading' ? `Downloading ${progress}%` : stage === 'verifying' ? 'Verifying APK…' : stage === 'installer' ? 'Open installer again' : 'Download & install', run: install }
      : { label: stage === 'checking' ? 'Checking…' : 'Check for updates', run: () => check(true) }

  return <View testID="android-update-settings" style={[styles.card, { backgroundColor: colors.raised, borderColor: colors.border }]}>
    <View style={styles.cardHeader}>
      <ShieldCheck size={18} color={channel === 'sideload' ? colors.green : colors.muted} />
      <View style={styles.cardCopy}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Android updates</Text>
        <Text style={[styles.caption, { color: colors.muted }]}>{status}</Text>
      </View>
    </View>
    {stage === 'permission' ? <Text style={[styles.notice, { color: colors.orange }]}>Enable “Allow from this source” for AgentsDock, return here, then continue. Android still asks you to confirm the update.</Text> : null}
    {stage === 'installer' ? <Text style={[styles.notice, { color: colors.green }]}>The APK passed checksum, package, version, and signing-certificate verification. Confirm the update in Android’s installer.</Text> : null}
    {error ? <Text accessibilityRole="alert" style={[styles.notice, { color: colors.red }]}>{error}</Text> : null}
    <View style={styles.actions}>
      <SmallButton testID="android-update-action" label={action.label} disabled={busy} onPress={() => void action.run()} primary={Boolean(update)} />
      {update ? <SmallButton label="Release notes" onPress={() => void Linking.openURL(update.releaseUrl)} icon={ExternalLink} /> : null}
      {update && !busy ? <SmallButton label="Check again" onPress={() => void check(true)} icon={RefreshCw} /> : null}
    </View>
    {channel === 'sideload' && nativeState ? <Text style={[styles.detail, { color: colors.muted }]}>Installed build {nativeState.versionCode} · release signer pinned</Text> : null}
  </View>
}

function updateStatusText(channel: string, stage: string, tagName?: string, versionCode?: number, progress = 0): string {
  if (channel === 'play') return 'This build is managed by Google Play; sideload installation authority is absent.'
  if (channel === 'unavailable') return 'The native Android updater is unavailable in this build.'
  if (stage === 'checking') return 'Checking signed Android beta releases on GitHub…'
  if (stage === 'downloading') return `Downloading the signed APK · ${progress}%`
  if (stage === 'verifying') return 'Verifying checksum, package identity, version, and release signer…'
  if (stage === 'permission') return 'Android needs one-time permission to install updates from AgentsDock.'
  if (stage === 'installer') return 'Verified update handed to Android’s system installer.'
  if (stage === 'up-to-date') return 'This Android beta is up to date.'
  if (stage === 'error') return 'The update could not be completed.'
  if (versionCode) return `${releaseLabel(tagName)} build ${versionCode} is ready.`.trim()
  return 'Signed sideload updates are enabled for this build.'
}

function releaseLabel(tagName?: string): string {
  return tagName?.startsWith('android-v') ? tagName.slice('android-v'.length) : 'beta update'
}

function SmallButton({ label, onPress, disabled, primary, icon: Icon, testID }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean; icon?: typeof Download; testID?: string }) {
  const colors = usePalette()
  return <Pressable
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={label}
    disabled={disabled}
    onPress={onPress}
    style={({ pressed }) => [styles.button, {
      backgroundColor: primary ? colors.blue : colors.surface,
      borderColor: primary ? colors.blue : colors.border,
      opacity: disabled ? 0.45 : pressed ? 0.68 : 1,
    }]}
  >
    {Icon ? <Icon size={14} color={primary ? 'white' : colors.text} /> : null}
    <Text style={{ color: primary ? 'white' : colors.text, fontSize: 11, fontWeight: '800' }}>{label}</Text>
  </Pressable>
}

const styles = StyleSheet.create({
  bannerSlot: { flexShrink: 0, paddingHorizontal: 12, paddingTop: 8 },
  banner: { width: '100%', maxWidth: 740, minHeight: 58, alignSelf: 'center', borderRadius: 7, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerCopy: { flex: 1, gap: 2 },
  bannerTitle: { fontSize: 12, fontWeight: '800' },
  caption: { fontSize: 10.5, lineHeight: 14 },
  iconButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 7, padding: 11, gap: 9 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  cardCopy: { flex: 1, gap: 2 },
  cardTitle: { fontSize: 13, fontWeight: '800' },
  notice: { fontSize: 11, lineHeight: 16 },
  detail: { fontSize: 9.5 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  button: { minHeight: 44, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
})
