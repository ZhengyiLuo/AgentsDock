# AgentsDock Mobile

This directory contains the shipping iPhone/iPad React Native client. Its bundle
identifier is `com.zhengyiluo.ZenithDock`, shared with TestFlight; installing a
development build with this identifier can replace the installed TestFlight app.

For an independent local device preview, set `AGENTSDOCK_APP_VARIANT=development`
for both Expo prebuild and Metro. This selects **AgentsDock Dev**, app identifiers
ending in `.dev`, and a separate `agentsdock-dev` URL scheme. The shipping config
in `app.json` is unchanged. Regenerate native projects when switching variants;
Expo does not automatically update an existing native project in `run:ios`.
Before installing, verify the built app has the `.dev` identifier. A physical
iPhone also needs Apple development signing and a provisioning profile. Expo Go
cannot host this app's custom native modules; use a locally compiled Debug app.

The local Debug app does not include `expo-dev-client`: development-client URL
links do not configure its JavaScript bundle source. Set React Native's native
bundler host (`RCT_jsLocation`) to the reachable Metro host and port. On a phone,
use a LAN address for local Wi-Fi or a reachable tailnet address when testing
off Wi-Fi. The Metro host is separate from the saved AgentsDock server address;
a reachable chat server cannot load a missing Debug bundle. Verify a cold launch
after changing the native host. Debug still requires Metro to be running;
Release builds bundle JavaScript and do not require the development computer.

Settings -> Language offers System, English, and Simplified Chinese. This is a
device-local preference; changing servers does not reset it. System follows the
device language, with unsupported locales falling back to English. This first
preview localizes the primary app controls, dates, and many app-authored notices;
some advanced actions and raw server errors may remain English. Chat messages,
server names, folder names, file paths, and provider output retain their
original text. Mobile reuses unambiguous desktop translations and keeps
mobile-only wording in
`src/i18n/zh-CN.extra.json`. After changing that file or the desktop catalog,
run `pnpm run locale:generate` and the focused localization tests. Native iOS
permission prompts and platform language metadata require a rebuilt app; a JS
reload alone cannot update them. App Store listing language is managed
separately in App Store Connect.

The pnpm patch for `expo@57.0.4` backports the platform-aware HMR reload from
[Expo #48944](https://github.com/expo/expo/pull/48944). Without it, opening a lazy
file viewer after Metro disconnects calls the browser-only `window.location`
on native and throws. The patch changes only JavaScript; it does not change the
native Expo ABI or eagerly load the editor/video modules. Keep it until the
installed Expo version includes that fix, and run
`node --test tests/expo-hmr-recovery.test.mjs` after dependency changes.
Restart Metro and reload the Dev app after applying the patch. A stale dev
bundle can still require one full reload; release builds do not use HMR.

`@expo/ui` is pinned to 57.0.7 for the iOS hosted-view touch-handler cleanup
([Expo #47713](https://github.com/expo/expo/pull/47713)). Older native builds can
leave recycled menu views intercepting taps in Settings and other modals. After
changing this dependency, run CocoaPods and rebuild/reinstall the native app;
Fast Refresh cannot update this fix. ExpoUI builds from source against this
app's ExpoModulesCore. `verify:ios-native` checks the package/pod/source parity.
The native regression is `tests/e2e/settings-touch.yaml`: run with Maestro on
an isolated Dev simulator at Home with at least one saved profile (offline is
fine). It cycles Servers -> Settings -> Appearance, verifies the selected theme
after each tap, and finishes on System. Dismiss any simulator-only notification
entitlement warning before running; do not mistake that overlay for this bug.

## Agents and app updates

Mobile exposes OpenCode and Gemini only when the connected server advertises
their supported contracts. OpenCode free models do not require native account
credentials. Gemini is Custom API-only and sends the `gemini_acp_v1` client
capability; its run-owned approvals use authenticated native-control requests.
Configure credentials on the server machine, not on the phone. Permission
choices follow the server catalog, and changing OpenCode permissions starts a
new native context while preserving the displayed chat history. Unsupported
Gemini fork and provider-reload controls are not offered.

Gemini API availability does not imply workspace trust. Cross-chat mentions
require its native AgentsDock MCP tool to load in that chat's directory. If
ordinary replies work but communication is blocked, review folder trust and MCP
settings in native Gemini on the server. Trust only recognized directories;
the app does not grant trust or bypass individual tool approvals.

Settings -> App updates is available on both platforms. Android sideload builds
check signed APK metadata and use Android's confirmation-based installer; Play
builds do not acquire sideload installation authority. Discovery scans at most
five bounded release pages and reports an incomplete scan as an error, not as
up to date. iOS links to the App Store and TestFlight; it does not install APKs
or bypass Apple's distribution process. Older installed clients need a new
published build to acquire these changes.

## License

AgentsDock's original mobile code is licensed under the
[Apache License 2.0](../LICENSE), except where otherwise stated. The local
[LICENSE](LICENSE) preserves the upstream Expo template's MIT notice; it does
not replace the project license. Separately licensed native modules and
vendored dependencies retain their own terms. See [NOTICE](../NOTICE).

## Local development

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test:server-setup
node scripts/run-history-tests.mjs src/lib/team-references.test.ts
```

These checks do not build or upload a native app. The generated root `ios/` and
`android/` projects, CocoaPods dependencies, signing material, and archives are
not source files in this repository. Native code under `modules/*/ios/` and
`modules/*/android/`, plus Expo config plugins, **is** source and must be retained.

To build locally on a Mac with Xcode, first generate the iOS project:

```sh
pnpm exec expo prebuild --platform ios
pnpm exec expo run:ios
```

Choose a local simulator or configure your own signing team for a device.
Do not use the published application's bundle identifier if installing over
your existing app would replace data you need. Configure native customizations
through `app.json`, plugins, and local modules. If regenerating an existing
native project with `--clean`, back up any manual native edits first: that flag
deletes and recreates the generated project. See
[Expo's native generation guide](https://docs.expo.dev/workflow/continuous-native-generation/).

The app connects directly to the same AgentsDock server contract as desktop.
The Home **New chat** button inherits the last open chat on the current server:
agent, native/Custom API mode, model, effort, and that agent's permissions.
If the chat list only contains summary metadata, creation first reads a small
detail page to resolve the permissions. A failed read leaves creation retryable.
Without a valid selected chat, the saved new-chat preferences remain the fallback.
Switching servers restores that server's own selection and preferences.
For a new blank chat, keep the previous agent and mode when available; otherwise
randomly choose from available native/API choices across all supported agents,
with fresh model and permission defaults. Only an empty candidate set blocks
creation for agent availability. A failed message does not change the inherited
agent, model, or permissions. Known pre-creation workspace/API rejections permit
trying remaining candidates using the server's default directory, each at most
once. Explicit creation settings and existing chats are unchanged;
authentication errors, timeouts and ambiguous server failures are never replayed.

Open **Servers → Add Server**. The manual fields are visible below the subtle
**or add manually** caption. Enter the server URL and access token, then test
the connection before saving. The app authenticates the server identity and
stores the token in SecureStore. **Scan QR code** in Add Server opens the camera
in a square viewport and reads a connection QR from a server terminal or another
connected desktop. It shows a compact name/address review; **Edit details** opens
the manual fields. The app checks authenticated
health and any QR identity before enabling **Add**; nothing is saved on scan or
cancel. Camera permission is requested only on scanner entry, not app launch.
QR-image import and connection deep links remain disabled. The terminal URL scheme remains
registered. Plain HTTP is intentionally permitted for private LAN and Tailscale
endpoints.

Any saved server can be removed, including the current or last one. Removal
only forgets this device's connection and credential; it does not stop remote
tasks or delete server chats. The next saved server is selected when available;
otherwise the app returns to setup. Cached chats and drafts remain available
when the same server identity is added again.

QR format v1 remains supported. Format v2 carries explicit candidate URLs and a
required server identity. Mobile races bounded health checks, keeps the matching
route and saves alternatives for reconnect across Wi-Fi/Tailscale. All-address
failure keeps the profile intact. Existing single-address profiles need a new QR
to learn alternatives. A phone must reach an included address itself, even when
another desktop can already connect. See
[network coverage](../docs/SERVER_CONNECTION_SHARING.md#network-coverage).

Camera scanning requires a new native build with `expo-camera`; reloading an older
Dev binary is not enough. The scanner only uses camera permission, not microphone
or photo-library access. Test real capture on a physical iOS/Android device; the
iOS simulator can exercise the UI and connection flow but has no physical camera.
Keep `expo-camera` in the iOS autolinking `buildFromSource` list: its precompiled
framework does not match this project's ExpoModulesCore ABI. Run the existing
native dependency and bundled-framework checks after rebuilding.

Chat previews keep **Download** and **Pin** on one compact row. On iOS,
**Download** opens the native share sheet directly after an authenticated,
cancellable download. The system offers applicable actions such as Save Image,
Save Video, Save to Files and installed app destinations. Closing that sheet is
not reported as a successful save. The existing **Share** shortcut is unchanged.
On Android, Download opens a bottom chooser with **Save to Files**, **Save to
Photos** for supported media, and **Share / Open in...**. Explicit saving reuses
the authenticated transfer and integrity checks; success is reported only after
the native save completes, and denied access offers a Settings link.

The media-saving capability requires a native app containing `expo-media-library`,
compiled from source on iOS. The adapter supports add-only access on iOS, uses permission-free
MediaStore insertion on Android 10+, and permits legacy storage writes only
through Android 9. Broad Android photo/video read permissions remain blocked.
Keep `withAndroidMediaSave.cjs` before `expo-media-library` in the plugin list;
manifest mods run in reverse order. Verify the composed permission configuration
with `node --test tests/media-save-config.test.mjs`, and the rendered controls
with `node scripts/run-file-transfer-tests.mjs`. Device-supported photo/video
formats can be saved; other files retain Download and Share. No server update
is needed.

Keep dependency caches, temporary files, archives, DerivedData, exports and
release logs in a local build-output directory excluded from Git. Configure
paths for your own workstation; never commit signing material or release logs.
Publishing to TestFlight requires explicit user authorization; local validation
alone does not authorize an upload. See [Mac parity audit](docs/MAC_PARITY_AUDIT.md)
for the implemented goal/chat controls and remaining desktop differences.

## Architecture

HTTP deadlines cover response headers and body consumption. Cancellation also
settles the client promise independently of the native fetch/body reader: some
iOS native body reads remain pending after transport cancellation. Timeout and
unexpected interruption errors are normalized; caller/client-scope cancellation
keeps its original ownership. Confirmed HTTP failures remain server errors,
including when their error body stalls. Mutations are never replayed here.

Selected-chat recovery uses its existing bounded retry sequence, retaining the
cached transcript. A transient automatic session-list refresh failure degrades
the saved profile's connection status without replacing the global user-action
error banner. Subsequent successful refresh clears that profile diagnostic.
Regression checks include `AgentServerClient.cancellation.test.ts`, the client
scope suite, and the store integration/timeline-recovery suites. Native failure
verification should include stalled headers and a partial JSON body, then allow
the next request to succeed without a tap. Use an isolated local test endpoint;
do not interrupt a user's working server to inject these failures.

Shared visual roles and contribution rules are documented in
[Mobile design tokens](docs/DESIGN_SYSTEM.md). Use `src/theme.ts` for typography,
weights, palette, spacing and corners instead of adding per-screen values.

- Expo SDK 57 / React Native 0.86 New Architecture
- Zustand endpoint-scoped state and bounded AsyncStorage transcript cache
- FlashList semantic timeline with stable keys and backward paging
- Expo native image, video, document, notification, sharing, and secure storage
- WebView-hosted xterm attached to each chat's persistent server tmux session
- Adaptive iPhone stacked navigation and iPad split-view workspace

`src/terminal/xtermAssets.ts` is generated by `scripts/embed-xterm.mjs` during
installation. Do not edit it manually.

`src/lib/backend-mark-assets.ts` is generated by `scripts/embed-backend-marks.mjs`
from the original Claude/Codex PNG and desktop Gemini SVG artwork during installation. These small
marks are embedded in JavaScript in both Debug and Release, so rendering or
remounting them never depends on a separate Metro asset request. After updating
the artwork, run `pnpm run embed:backend-marks` and
`node --test tests/backend-mark.test.mjs`.

## Local build output

The standalone Apple-silicon simulator build is generated at:

```text
build/ios-react-native-release/Build/Products/Release-iphonesimulator/AgentsDockReact.app
```

The generated workspace and scheme derive from the Expo app name. Open the
generated `.xcworkspace` in `ios/` and select a simulator. A Release build bundles
its JavaScript and does not require Metro. Native generation and device builds
must be validated separately from the Node-only source checks.
