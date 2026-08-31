package com.serichka.setsuna

import android.app.Activity
import android.content.Intent
import android.webkit.JavascriptInterface
import org.json.JSONObject

class MobileFileBridge(private val activity: Activity) {
    @JavascriptInterface
    fun selectDictionaries(): String = wrap {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/zip"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/json", "text/json"))
        }
        activity.runOnUiThread {
            activity.startActivityForResult(intent, MainActivity.REQUEST_DICTIONARIES)
        }
        JSONObject().put("opened", true)
    }

    private fun wrap(block: () -> Any): String = try {
        JSONObject().put("ok", true).put("value", block()).toString()
    } catch (error: Exception) {
        JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    }
}
