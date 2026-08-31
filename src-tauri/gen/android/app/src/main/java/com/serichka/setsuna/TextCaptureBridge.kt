package com.serichka.setsuna

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.webkit.JavascriptInterface
import org.json.JSONObject

class TextCaptureBridge(private val activity: Activity) {
    @JavascriptInterface
    fun status(): String = wrap {
        val prefs = activity.getSharedPreferences(TextCaptureService.PREFS, Activity.MODE_PRIVATE)
        JSONObject()
            .put("running", prefs.getBoolean("running", false))
            .put("connected", prefs.getBoolean("connected", false))
            .put("url", prefs.getString("url", "") ?: "")
            .put("error", prefs.getString("error", "") ?: "")
    }

    @JavascriptInterface
    fun start(url: String): String = wrap {
        require(url.startsWith("ws://") || url.startsWith("wss://")) { "Enter a ws:// or wss:// address." }
        val intent = Intent(activity, TextCaptureService::class.java)
            .setAction(TextCaptureService.ACTION_START)
            .putExtra(TextCaptureService.EXTRA_URL, url)
        activity.runOnUiThread {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) activity.startForegroundService(intent)
            else activity.startService(intent)
        }
        JSONObject().put("started", true)
    }

    @JavascriptInterface
    fun stop(): String = wrap {
        activity.runOnUiThread { activity.stopService(Intent(activity, TextCaptureService::class.java)) }
        JSONObject().put("stopped", true)
    }

    private fun wrap(block: () -> Any): String = try {
        JSONObject().put("ok", true).put("value", block()).toString()
    } catch (error: Exception) {
        JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    }
}
