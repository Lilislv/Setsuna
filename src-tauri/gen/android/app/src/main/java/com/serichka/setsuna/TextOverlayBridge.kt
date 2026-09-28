package com.serichka.setsuna

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.webkit.JavascriptInterface
import org.json.JSONObject

class TextOverlayBridge(private val activity: Activity) {
    @JavascriptInterface
    fun timerSnapshot(): String = NativeDictionary.flowTimer(0)

    @JavascriptInterface
    fun status(): String = wrap {
        JSONObject().put("granted", Settings.canDrawOverlays(activity))
            .put("dismissed", activity.getSharedPreferences(TextCaptureService.PREFS, Activity.MODE_PRIVATE).getBoolean("overlay_dismissed", false))
    }

    @JavascriptInterface
    fun enable(): String = wrap {
        activity.getSharedPreferences(TextCaptureService.PREFS, Activity.MODE_PRIVATE).edit()
            .putBoolean("overlay_dismissed", false).apply()
        JSONObject().put("enabled", true)
    }

    @JavascriptInterface
    fun requestPermission(): String = wrap {
        if (!Settings.canDrawOverlays(activity)) {
            activity.runOnUiThread {
                activity.startActivity(
                    Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}")),
                )
            }
        }
        JSONObject().put("opened", true).put("granted", Settings.canDrawOverlays(activity))
    }

    @JavascriptInterface
    fun show(text: String, optionsJson: String): String = wrap {
        if (activity.getSharedPreferences(TextCaptureService.PREFS, Activity.MODE_PRIVATE).getBoolean("overlay_dismissed", false)) {
            return@wrap JSONObject().put("shown", false).put("dismissed", true)
        }
        if (!Settings.canDrawOverlays(activity)) error("Allow display over other apps for Setsuna first.")
        activity.getSharedPreferences(TextCaptureService.PREFS, Activity.MODE_PRIVATE).edit()
            .putBoolean("overlay_active", true)
            .putString("overlay_options", optionsJson)
            .apply()
        val intent = Intent(activity, TextOverlayService::class.java)
            .setAction(TextOverlayService.ACTION_SHOW)
            .putExtra(TextOverlayService.EXTRA_TEXT, text)
            .putExtra(TextOverlayService.EXTRA_OPTIONS, optionsJson)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
        JSONObject().put("shown", true)
    }

    @JavascriptInterface
    fun hide(): String = wrap {
        activity.getSharedPreferences(TextCaptureService.PREFS, Activity.MODE_PRIVATE).edit()
            .putBoolean("overlay_active", false)
            .apply()
        activity.stopService(Intent(activity, TextOverlayService::class.java))
        JSONObject().put("hidden", true)
    }

    private fun wrap(block: () -> Any): String = try {
        JSONObject().put("ok", true).put("value", block()).toString()
    } catch (error: Exception) {
        JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    }
}
