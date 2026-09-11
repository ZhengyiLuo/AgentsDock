package com.zhengyiluo.agentsdock.updater

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File

class UpdateInstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> confirmationIntent(intent)?.let { confirmation ->
        confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(confirmation)
      }
      PackageInstaller.STATUS_SUCCESS -> cleanup(intent)
      else -> cleanup(intent)
    }
  }

  @Suppress("DEPRECATION")
  private fun confirmationIntent(intent: Intent): Intent? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
  } else {
    intent.getParcelableExtra(Intent.EXTRA_INTENT)
  }

  private fun cleanup(intent: Intent) {
    intent.getStringExtra(EXTRA_APK_PATH)?.let { path -> runCatching { File(path).delete() } }
  }
}
