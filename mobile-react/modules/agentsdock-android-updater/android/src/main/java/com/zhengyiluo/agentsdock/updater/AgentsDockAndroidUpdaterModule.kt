package com.zhengyiluo.agentsdock.updater

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.Locale

private const val MODULE_NAME = "AgentsDockAndroidUpdater"
private const val EXPECTED_PACKAGE_NAME = "com.zhengyiluo.agentsdock"
private const val EXPECTED_SIGNER_SHA256 = "3ff67f11c62187c52f18e48e7ecd3cf25aa1fcf21ba0477c9eb9e3feeab82e5a"
private const val INSTALL_ACTION = "com.zhengyiluo.agentsdock.updater.INSTALL_STATUS"
internal const val EXTRA_APK_PATH = "agentsdock_apk_path"

class AgentsDockAndroidUpdaterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)

    AsyncFunction("getStateAsync") {
      val packageInfo = installedPackageInfo()
      mapOf(
        "available" to hasInstallPackagesPermissionDeclaration(),
        "canRequestPackageInstalls" to canRequestPackageInstalls(),
        "packageName" to context.packageName,
        "versionCode" to packageVersionCode(packageInfo),
        "versionName" to (packageInfo.versionName ?: ""),
        "signerSha256" to EXPECTED_SIGNER_SHA256,
      )
    }

    AsyncFunction("openInstallPermissionSettingsAsync") {
      if (!hasInstallPackagesPermissionDeclaration()) {
        throw UpdaterException("This build is managed by an app store and cannot install sideload updates.")
      }
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction true
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}"),
      ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      true
    }

    AsyncFunction("installPackageAsync") Coroutine { request: InstallPackageRequest ->
      withContext(Dispatchers.IO) {
        val verified = verifyPackage(request)
        if (!canRequestPackageInstalls()) {
          return@withContext mapOf(
            "permissionRequired" to true,
            "sessionId" to null,
            "versionCode" to verified.versionCode,
            "sha256" to verified.sha256,
          )
        }
        val sessionId = stagePackage(verified.file, verified.versionCode)
        mapOf(
          "permissionRequired" to false,
          "sessionId" to sessionId,
          "versionCode" to verified.versionCode,
          "sha256" to verified.sha256,
        )
      }
    }
  }

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React application context is unavailable" }

  @Suppress("DEPRECATION")
  private fun installedPackageInfo(): PackageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    context.packageManager.getPackageInfo(
      context.packageName,
      PackageManager.PackageInfoFlags.of(0),
    )
  } else {
    context.packageManager.getPackageInfo(context.packageName, 0)
  }

  @Suppress("DEPRECATION")
  private fun hasInstallPackagesPermissionDeclaration(): Boolean {
    val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getPackageInfo(
        context.packageName,
        PackageManager.PackageInfoFlags.of(PackageManager.GET_PERMISSIONS.toLong()),
      )
    } else {
      context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
    }
    return packageInfo.requestedPermissions?.contains(Manifest.permission.REQUEST_INSTALL_PACKAGES) == true
  }

  private fun canRequestPackageInstalls(): Boolean {
    if (!hasInstallPackagesPermissionDeclaration()) return false
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
  }

  private fun verifyPackage(request: InstallPackageRequest): VerifiedPackage {
    if (!hasInstallPackagesPermissionDeclaration()) {
      throw UpdaterException("Sideload updates are disabled in this distribution channel.")
    }
    if (!request.sha256.matches(Regex("^[0-9a-fA-F]{64}$"))) {
      throw UpdaterException("The update checksum is malformed.")
    }
    if (request.versionCode <= packageVersionCode(installedPackageInfo())) {
      throw UpdaterException("The downloaded APK is not newer than the installed app.")
    }
    val file = fileFromCacheUri(request.fileUri)
    if (!file.isFile || file.length() <= 0L) throw UpdaterException("The downloaded APK is missing.")
    if (request.sizeBytes <= 0L || file.length() != request.sizeBytes) {
      throw UpdaterException("The downloaded APK size does not match the release manifest.")
    }
    val actualSha256 = sha256(file)
    if (!actualSha256.equals(request.sha256, ignoreCase = true)) {
      throw UpdaterException("The downloaded APK checksum does not match the release manifest.")
    }
    val packageInfo = archivePackageInfo(file)
      ?: throw UpdaterException("Android could not read the downloaded APK.")
    if (packageInfo.packageName != EXPECTED_PACKAGE_NAME || packageInfo.packageName != context.packageName) {
      throw UpdaterException("The downloaded APK belongs to a different application.")
    }
    val archiveVersionCode = packageVersionCode(packageInfo)
    if (archiveVersionCode != request.versionCode) {
      throw UpdaterException("The downloaded APK version does not match the release manifest.")
    }
    val signers = currentSignerCertificates(packageInfo)
    if (signers.size != 1 || !sha256(signers.single()).equals(EXPECTED_SIGNER_SHA256, ignoreCase = true)) {
      throw UpdaterException("The downloaded APK is not signed by the pinned AgentsDock release key.")
    }
    return VerifiedPackage(file, archiveVersionCode, actualSha256)
  }

  private fun fileFromCacheUri(fileUri: String): File {
    val uri = Uri.parse(fileUri)
    if (uri.scheme != "file") throw UpdaterException("The update must be downloaded into app-private storage.")
    val file = File(requireNotNull(uri.path) { "Missing update file path" }).canonicalFile
    val roots = listOfNotNull(context.cacheDir, context.externalCacheDir).map { it.canonicalFile }
    if (roots.none { root -> file.path == root.path || file.path.startsWith("${root.path}${File.separator}") }) {
      throw UpdaterException("The update file is outside app-private cache storage.")
    }
    return file
  }

  @Suppress("DEPRECATION")
  private fun archivePackageInfo(file: File): PackageInfo? {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.packageManager.getPackageArchiveInfo(
        file.absolutePath,
        PackageManager.PackageInfoFlags.of(flags.toLong()),
      )
    } else {
      context.packageManager.getPackageArchiveInfo(file.absolutePath, flags)
    }
  }

  @Suppress("DEPRECATION")
  private fun currentSignerCertificates(packageInfo: PackageInfo): List<ByteArray> {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.signingInfo?.apkContentsSigners?.map { it.toByteArray() }.orEmpty()
    } else {
      packageInfo.signatures?.map { it.toByteArray() }.orEmpty()
    }
  }

  private fun stagePackage(file: File, versionCode: Long): Int {
    val installer = context.packageManager.packageInstaller
    val parameters = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(EXPECTED_PACKAGE_NAME)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
      }
    }
    val sessionId = installer.createSession(parameters)
    try {
      installer.openSession(sessionId).use { session ->
        FileInputStream(file).use { input ->
          session.openWrite("AgentsDock-$versionCode.apk", 0, file.length()).use { output ->
            input.copyTo(output)
            session.fsync(output)
          }
        }
        val statusIntent = Intent(context, UpdateInstallReceiver::class.java).apply {
          action = INSTALL_ACTION
          putExtra(EXTRA_APK_PATH, file.absolutePath)
        }
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          PendingIntent.FLAG_MUTABLE
        } else {
          0
        }
        val pendingIntent = PendingIntent.getBroadcast(context, sessionId, statusIntent, flags)
        session.commit(pendingIntent.intentSender)
      }
    } catch (error: Throwable) {
      runCatching { installer.abandonSession(sessionId) }
      throw error
    }
    return sessionId
  }
}

@OptimizedRecord
class InstallPackageRequest : Record {
  @Field lateinit var fileUri: String
  @Field lateinit var sha256: String
  @Field var sizeBytes: Long = 0
  @Field var versionCode: Long = 0
}

private data class VerifiedPackage(
  val file: File,
  val versionCode: Long,
  val sha256: String,
)

private class UpdaterException(message: String) : CodedException(message)

@Suppress("DEPRECATION")
private fun packageVersionCode(packageInfo: PackageInfo): Long = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
  packageInfo.longVersionCode
} else {
  packageInfo.versionCode.toLong()
}

private fun sha256(file: File): String {
  val digest = MessageDigest.getInstance("SHA-256")
  file.inputStream().buffered().use { input ->
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      if (read > 0) digest.update(buffer, 0, read)
    }
  }
  return sha256Hex(digest.digest())
}

private fun sha256(bytes: ByteArray): String = sha256Hex(MessageDigest.getInstance("SHA-256").digest(bytes))

private fun sha256Hex(bytes: ByteArray): String = bytes.joinToString("") { byte ->
  String.format(Locale.ROOT, "%02x", byte.toInt() and 0xff)
}
