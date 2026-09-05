package com.serichka.setsuna

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.Base64
import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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

    @JavascriptInterface
    fun captureScreen(): String = wrap {
        val latch = CountDownLatch(1)
        var encoded = ""
        var failure: Throwable? = null
        activity.runOnUiThread {
            try {
                val view = activity.window.decorView.rootView
                val bitmap = Bitmap.createBitmap(
                    view.width.coerceAtLeast(1),
                    view.height.coerceAtLeast(1),
                    Bitmap.Config.ARGB_8888,
                )
                view.draw(Canvas(bitmap))
                val output = ByteArrayOutputStream()
                bitmap.compress(Bitmap.CompressFormat.JPEG, 90, output)
                bitmap.recycle()
                encoded = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
            } catch (error: Throwable) {
                failure = error
            } finally {
                latch.countDown()
            }
        }
        if (!latch.await(5, TimeUnit.SECONDS)) error("Screen capture timed out.")
        failure?.let { throw it }
        if (encoded.isBlank()) error("Screen capture returned an empty image.")
        encoded
    }

    private fun wrap(block: () -> Any): String = try {
        JSONObject().put("ok", true).put("value", block()).toString()
    } catch (error: Exception) {
        JSONObject().put("ok", false).put("error", error.message ?: error.javaClass.simpleName).toString()
    }
}
