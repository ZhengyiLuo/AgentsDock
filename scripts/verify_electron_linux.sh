#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR_INPUT="${1:?usage: verify_electron_linux.sh <artifact-dir> <expected-version> [stable|beta] [x64|arm64]}"
EXPECTED_VERSION="${2:?usage: verify_electron_linux.sh <artifact-dir> <expected-version> [stable|beta] [x64|arm64]}"
EXPECTED_TRACK="${3:-stable}"
EXPECTED_ARCH="${4:-x64}"
ARTIFACT_DIR="$(cd "$ARTIFACT_DIR_INPUT" && pwd)"

case "$EXPECTED_TRACK" in
  stable)
    METADATA_NAME="latest-linux.yml"
    EXPECTED_CHANNEL="latest"
    ;;
  beta)
    METADATA_NAME="beta-linux.yml"
    EXPECTED_CHANNEL="beta"
    ;;
  *) echo "Expected track must be stable or beta." >&2; exit 2 ;;
esac
case "$EXPECTED_ARCH" in
  x64)
    APPIMAGE_ARCH="x86_64"
    TARBALL_ARCH="x64"
    EXPECTED_RUNNER_ARCH="x86_64"
    ;;
  arm64)
    APPIMAGE_ARCH="arm64"
    TARBALL_ARCH="arm64"
    EXPECTED_RUNNER_ARCH="aarch64"
    METADATA_NAME="${METADATA_NAME%.yml}-arm64.yml"
    ;;
  *) echo "Expected architecture must be x64 or arm64." >&2; exit 2 ;;
esac

ACTUAL_RUNNER_ARCH="$(uname -m)"
[[ "$ACTUAL_RUNNER_ARCH" == "$EXPECTED_RUNNER_ARCH" ]] || {
  echo "Linux $EXPECTED_ARCH verification requires a native $EXPECTED_RUNNER_ARCH runner (found $ACTUAL_RUNNER_ARCH)." >&2
  exit 2
}

APPIMAGE_NAME="AgentsDock-${EXPECTED_VERSION}-linux-${APPIMAGE_ARCH}.AppImage"
TARBALL_NAME="AgentsDock-${EXPECTED_VERSION}-linux-${TARBALL_ARCH}.tar.gz"
APPIMAGE="$ARTIFACT_DIR/$APPIMAGE_NAME"
TARBALL="$ARTIFACT_DIR/$TARBALL_NAME"
METADATA="$ARTIFACT_DIR/$METADATA_NAME"
[[ -f "$METADATA" ]] || { echo "Missing $METADATA_NAME" >&2; exit 2; }
[[ -f "$APPIMAGE" ]] || { echo "Missing $APPIMAGE_NAME" >&2; exit 2; }
[[ -f "$TARBALL" ]] || { echo "Missing $TARBALL_NAME" >&2; exit 2; }

mapfile -t APPIMAGES < <(find "$ARTIFACT_DIR" -maxdepth 1 -type f -name "AgentsDock-${EXPECTED_VERSION}-linux-*.AppImage" -print)
mapfile -t TARBALLS < <(find "$ARTIFACT_DIR" -maxdepth 1 -type f -name "AgentsDock-${EXPECTED_VERSION}-linux-*.tar.gz" -print)
[[ "${#APPIMAGES[@]}" -ge 1 && "${#APPIMAGES[@]}" -le 2 ]] || { echo "Expected one or two supported versioned AppImages" >&2; exit 2; }
for candidate in "${APPIMAGES[@]}"; do
  case "$(basename "$candidate")" in
    "AgentsDock-${EXPECTED_VERSION}-linux-x86_64.AppImage"|"AgentsDock-${EXPECTED_VERSION}-linux-arm64.AppImage") ;;
    *) echo "Unexpected Linux AppImage: $(basename "$candidate")" >&2; exit 2 ;;
  esac
done
[[ " ${APPIMAGES[*]} " == *" $APPIMAGE "* ]] || { echo "Missing target $APPIMAGE_NAME" >&2; exit 2; }
[[ "${#TARBALLS[@]}" -ge 1 && "${#TARBALLS[@]}" -le 2 ]] || { echo "Expected one or two supported versioned tarballs" >&2; exit 2; }
for candidate in "${TARBALLS[@]}"; do
  case "$(basename "$candidate")" in
    "AgentsDock-${EXPECTED_VERSION}-linux-x64.tar.gz"|"AgentsDock-${EXPECTED_VERSION}-linux-arm64.tar.gz") ;;
    *) echo "Unexpected Linux tarball: $(basename "$candidate")" >&2; exit 2 ;;
  esac
done
[[ " ${TARBALLS[*]} " == *" $TARBALL "* ]] || { echo "Missing target $TARBALL_NAME" >&2; exit 2; }
[[ -x "$APPIMAGE" ]] || { echo "AppImage is not executable" >&2; exit 2; }

ASAR_CLI="$(find "$ROOT/electron/node_modules/.pnpm" -path '*/node_modules/@electron/asar/bin/asar.js' -print -quit)"
FUSES_CLI="$(find "$ROOT/electron/node_modules/.pnpm" -path '*/node_modules/@electron/fuses/dist/bin.js' -print -quit)"
JS_YAML="$(find "$ROOT/electron/node_modules/.pnpm" -path '*/node_modules/js-yaml/index.js' -print -quit)"
[[ -f "$ASAR_CLI" && -f "$FUSES_CLI" && -f "$JS_YAML" ]] || { echo "Install Electron dependencies before verifying Linux artifacts." >&2; exit 2; }

PACKAGE_SHA512="$(node - "$JS_YAML" "$METADATA" "$EXPECTED_VERSION" "$APPIMAGE_NAME" <<'NODE'
const [yamlPath, metadataPath, expectedVersion, expectedPackage] = process.argv.slice(2)
const fs = require('fs')
const yaml = require(yamlPath)

function fail(message) {
  console.error(message)
  process.exit(2)
}

const metadata = yaml.load(fs.readFileSync(metadataPath, 'utf8'))
if (!metadata || metadata.version !== expectedVersion) {
  fail(`Updater metadata version does not match ${expectedVersion}`)
}
if (metadata.path !== expectedPackage || typeof metadata.sha512 !== 'string') {
  fail(`Updater metadata must point at ${expectedPackage}`)
}
if (!Array.isArray(metadata.files)) {
  fail('Updater metadata is missing files[]')
}
const entries = metadata.files.filter((entry) => entry && entry.url === expectedPackage)
if (entries.length !== 1 || typeof entries[0].sha512 !== 'string') {
  fail(`Updater metadata must contain exactly one files[] entry for ${expectedPackage}`)
}
if (entries[0].sha512 !== metadata.sha512) {
  fail('Updater metadata top-level and files[] sha512 values disagree')
}
process.stdout.write(entries[0].sha512)
NODE
)"
ACTUAL_SHA512="$(openssl dgst -sha512 -binary "$APPIMAGE" | openssl base64 -A)"
[[ "$ACTUAL_SHA512" == "$PACKAGE_SHA512" ]] || { echo "$METADATA_NAME sha512 does not match $APPIMAGE_NAME" >&2; exit 2; }

TEMP_DIR="$(mktemp -d /tmp/agentsdock-linux-verify.XXXXXX)"
cleanup() { rm -rf "$TEMP_DIR"; }
trap cleanup EXIT

python3 - "$TARBALL" "$TEMP_DIR/tar" <<'PY'
import posixpath
import sys
import tarfile

archive_path, destination = sys.argv[1:]

def unsafe(path):
    normalized = posixpath.normpath(path)
    return path.startswith('/') or normalized == '..' or normalized.startswith('../')

with tarfile.open(archive_path, 'r:gz') as archive:
    for member in archive.getmembers():
        if unsafe(member.name):
            raise SystemExit(f'Linux tarball contains an unsafe member path: {member.name!r}')
        if member.ischr() or member.isblk() or member.isfifo():
            raise SystemExit(f'Linux tarball contains a special device: {member.name!r}')
        if member.issym() or member.islnk():
            target = posixpath.join(posixpath.dirname(member.name), member.linkname)
            if unsafe(member.linkname) or unsafe(target):
                raise SystemExit(f'Linux tarball contains an unsafe link: {member.name!r}')
    archive.extractall(destination, filter='data')
PY

(
  cd "$TEMP_DIR"
  "$APPIMAGE" --appimage-extract >/dev/null
)
APP_ROOT="$TEMP_DIR/squashfs-root"
TARBALL_PREFIX="${TARBALL_NAME%.tar.gz}"
TAR_ROOT="$TEMP_DIR/tar/$TARBALL_PREFIX"
APPIMAGE_ASAR="$APP_ROOT/resources/app.asar"
TARBALL_ASAR="$TAR_ROOT/resources/app.asar"
APPIMAGE_UPDATE_CONFIG="$APP_ROOT/resources/app-update.yml"
TARBALL_UPDATE_CONFIG="$TAR_ROOT/resources/app-update.yml"
[[ -x "$APP_ROOT/AppRun" && -f "$APPIMAGE_ASAR" ]] || { echo "AppImage layout is incomplete" >&2; exit 2; }
[[ -d "$TAR_ROOT" && -f "$TARBALL_ASAR" ]] || { echo "Tarball layout is incomplete" >&2; exit 2; }
[[ -f "$APPIMAGE_UPDATE_CONFIG" && -f "$TARBALL_UPDATE_CONFIG" ]] || { echo "Linux packages are missing app-update.yml" >&2; exit 2; }
[[ ! -e "$APP_ROOT/resources/disable-auto-update" && ! -e "$TAR_ROOT/resources/disable-auto-update" ]] || { echo "Linux release package disables automatic updates" >&2; exit 2; }
cmp -s "$APPIMAGE_UPDATE_CONFIG" "$TARBALL_UPDATE_CONFIG" || { echo "AppImage and tarball updater configurations differ" >&2; exit 2; }
node - "$JS_YAML" "$APPIMAGE_UPDATE_CONFIG" "$EXPECTED_CHANNEL" <<'NODE'
const [yamlPath, configPath, expectedChannel] = process.argv.slice(2)
const fs = require('fs')
const yaml = require(yamlPath)
const config = yaml.load(fs.readFileSync(configPath, 'utf8'))
if (!config || config.provider !== 'github' || config.owner !== 'ZhengyiLuo' || config.repo !== 'AgentsDock' || config.channel !== expectedChannel) {
  console.error('Packaged updater configuration does not match the public AgentsDock release feed')
  process.exit(2)
}
NODE
mapfile -t TAR_TOP_LEVEL < <(find "$TEMP_DIR/tar" -mindepth 1 -maxdepth 1 -print)
[[ "${#TAR_TOP_LEVEL[@]}" -eq 1 && "${TAR_TOP_LEVEL[0]}" == "$TAR_ROOT" ]] || { echo "Tarball must contain exactly one expected top-level directory" >&2; exit 2; }
mapfile -t DESKTOP_FILES < <(find "$APP_ROOT" -maxdepth 2 -type f -name '*.desktop' -print)
[[ "${#DESKTOP_FILES[@]}" -eq 1 ]] || { echo "AppImage must contain exactly one desktop entry" >&2; exit 2; }
if grep -Eq '^Exec=.*--no-sandbox([[:space:]]|$)' "${DESKTOP_FILES[0]}"; then
  echo "AppImage desktop launcher must not force --no-sandbox" >&2
  exit 2
fi

FUSE_SENTINEL='dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
find_electron_binary() {
  local app_root="$1"
  local label="$2"
  local candidate
  local -a matches=()
  while IFS= read -r -d '' candidate; do
    if LC_ALL=C grep -a -F -q -- "$FUSE_SENTINEL" "$candidate"; then
      matches+=("$candidate")
    fi
  done < <(find "$app_root" -maxdepth 1 -type f -perm -111 -print0)
  if [[ "${#matches[@]}" -ne 1 ]]; then
    echo "$label must contain exactly one Electron executable with a fuse sentinel" >&2
    return 2
  fi
  printf '%s\n' "${matches[0]}"
}

APPIMAGE_BINARY="$(find_electron_binary "$APP_ROOT" AppImage)"
TARBALL_BINARY="$(find_electron_binary "$TAR_ROOT" Tarball)"
cmp -s "$APPIMAGE_BINARY" "$TARBALL_BINARY" || { echo "AppImage and tarball Electron executables differ" >&2; exit 2; }
cmp -s "$APPIMAGE_ASAR" "$TARBALL_ASAR" || { echo "AppImage and tarball application payloads differ" >&2; exit 2; }

FUSE_REPORT="$(node "$FUSES_CLI" read --app "$APPIMAGE_BINARY")"
for expectation in \
  'RunAsNode is Disabled' \
  'EnableCookieEncryption is Enabled' \
  'EnableNodeOptionsEnvironmentVariable is Disabled' \
  'EnableNodeCliInspectArguments is Disabled' \
  'EnableEmbeddedAsarIntegrityValidation is Enabled' \
  'OnlyLoadAppFromAsar is Enabled'; do
  [[ "$FUSE_REPORT" == *"$expectation"* ]] || { echo "Unsafe Electron fuse state: expected '$expectation'" >&2; exit 2; }
done

node "$ASAR_CLI" list "$APPIMAGE_ASAR" > "$TEMP_DIR/asar-files.txt"
if grep -Eiq '\.(map|ts|tsx|d\.ts|d\.mts|d\.cts)$' "$TEMP_DIR/asar-files.txt"; then
  echo "The Linux package contains source maps or TypeScript sources." >&2
  exit 2
fi
node "$ASAR_CLI" extract "$APPIMAGE_ASAR" "$TEMP_DIR/app"
PACKAGE_VERSION="$(node -p "require(process.argv[1]).version" "$TEMP_DIR/app/package.json")"
[[ "$PACKAGE_VERSION" == "$EXPECTED_VERSION" ]] || { echo "Packaged version $PACKAGE_VERSION does not match $EXPECTED_VERSION" >&2; exit 2; }
if [[ -n "${AGENTSDOCK_EXPECTED_BUILD_NUMBER:-}" ]]; then
  PACKAGE_BUILD="$(node -p "require(process.argv[1]).releaseBuildNumber" "$TEMP_DIR/app/package.json")"
  [[ "$PACKAGE_BUILD" == "$AGENTSDOCK_EXPECTED_BUILD_NUMBER" ]] || { echo "Packaged build $PACKAGE_BUILD does not match $AGENTSDOCK_EXPECTED_BUILD_NUMBER" >&2; exit 2; }
fi

LEGACY_PRODUCT="$(printf '%s%s' 'Zeni' 'th')"
FORBIDDEN_PATTERN="${LEGACY_PRODUCT}"
# Organization-specific checks belong in private configuration, not source.
if [[ -n "${AGENTSDOCK_PRIVATE_CONTENT_PATTERN:-}" ]]; then
  FORBIDDEN_PATTERN+="|${AGENTSDOCK_PRIVATE_CONTENT_PATTERN}"
fi
AUDIT_TARGETS=("$TEMP_DIR/app/out" "$TEMP_DIR/app/package.json")
if grep -R -I -q -i -E "$FORBIDDEN_PATTERN" "${AUDIT_TARGETS[@]}"; then
  echo "Linux release code contains a legacy brand, personal host, or personal path." >&2
  exit 2
fi
SECRET_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|gh[opusr]_[A-Za-z0-9]{20,}|sk-(proj-|ant-)?[A-Za-z0-9_-]{20,}'
if grep -R -I -q -E -e "$SECRET_PATTERN" "${AUDIT_TARGETS[@]}"; then
  echo "Linux release code appears to contain a private key or API token." >&2
  exit 2
fi

SMOKE_DATA="$TEMP_DIR/user-data"
mkdir -p "$SMOKE_DATA"
set +e
# This launches the real packaged binary with a fresh, disposable profile,
# so AGENTSDOCK_DISABLE_ANALYTICS keeps it from minting and reporting a
# brand-new anonymous install id to production Mixpanel on every CI run.
timeout --kill-after=5s 12s xvfb-run -a env APPIMAGE_EXTRACT_AND_RUN=1 AGENTSDOCK_USER_DATA="$SMOKE_DATA" AGENTSDOCK_DISABLE_ANALYTICS=1 "$APPIMAGE" >"$TEMP_DIR/smoke.log" 2>&1
SMOKE_EXIT=$?
set -e
if [[ "$SMOKE_EXIT" -ne 124 ]]; then
  tail -80 "$TEMP_DIR/smoke.log" >&2
  echo "Linux AppImage did not remain alive for the smoke window (exit $SMOKE_EXIT)" >&2
  exit 2
fi

echo "Verified AgentsDock $EXPECTED_VERSION Linux $EXPECTED_ARCH ($EXPECTED_TRACK): updater metadata, hashes, AppImage/tarball parity, archive safety, fuses, privacy, and sustained AppImage-wrapper smoke launch."
