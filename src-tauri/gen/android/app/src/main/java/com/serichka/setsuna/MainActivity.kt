package com.serichka.setsuna

import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.provider.OpenableColumns
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.content.ContextCompat
import java.io.File
import java.io.FileOutputStream

class MainActivity : TauriActivity() {
  private var setsunaWebView: WebView? = null
  private var pendingSharedText: String? = null
  private var pendingOverlayLookup: String? = null
  private val captureReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val text = intent?.getStringExtra(TextCaptureService.EXTRA_TEXT)?.trim().orEmpty()
      if (text.isEmpty()) return
      if (setsunaWebView == null) pendingSharedText = text else dispatchIncomingText(text)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    ContextCompat.registerReceiver(this, captureReceiver, IntentFilter(TextCaptureService.ACTION_TEXT), ContextCompat.RECEIVER_NOT_EXPORTED)
    receiveIncomingText(intent)
  }

    override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    setsunaWebView = webView
    webView.addJavascriptInterface(AnkiDroidBridge(this), "SetsunaAnkiDroid")
    webView.addJavascriptInterface(TextOverlayBridge(this), "SetsunaTextOverlay")
    webView.addJavascriptInterface(TextCaptureBridge(this), "SetsunaTextCapture")
    webView.addJavascriptInterface(MobileFileBridge(this), "SetsunaMobileFiles")
    pendingSharedText?.let {
      dispatchIncomingText(it)
      pendingSharedText = null
    }
    pendingOverlayLookup?.let {
      dispatchWebEvent("setsuna-mobile-lookup", it)
      pendingOverlayLookup = null
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    receiveIncomingText(intent)
  }

  override fun onDestroy() {
    runCatching { unregisterReceiver(captureReceiver) }
    setsunaWebView = null
    super.onDestroy()
  }

  @Deprecated("Deprecated in Android API 35")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != REQUEST_DICTIONARIES || resultCode != RESULT_OK || data == null) return
    val uris = buildList {
      data.data?.let(::add)
      data.clipData?.let { clip -> for (index in 0 until clip.itemCount) add(clip.getItemAt(index).uri) }
    }.distinct()
    if (uris.isEmpty()) return
    dispatchWebEvent("setsuna-mobile-dictionaries-copying", uris.size.toString())
    Thread {
      val paths = uris.mapIndexedNotNull { index, uri -> copyDictionaryUri(uri, index) }
      if (paths.isNotEmpty()) {
        dispatchWebEvent("setsuna-mobile-dictionaries", org.json.JSONArray(paths).toString())
      } else {
        dispatchWebEvent("setsuna-mobile-dictionaries-copy-failed", "Could not read the selected dictionary files.")
      }
    }.start()
  }

  private fun copyDictionaryUri(uri: android.net.Uri, index: Int): String? = runCatching {
    val displayName = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) else null
    } ?: "dictionary-${System.currentTimeMillis()}.zip"
    val safeName = displayName.replace(Regex("[^A-Za-z0-9._-]"), "_")
    val directory = File(cacheDir, "dictionary-imports").apply { mkdirs() }
    val target = File(directory, "${System.currentTimeMillis()}-$index-$safeName")
    contentResolver.openInputStream(uri)?.use { input -> FileOutputStream(target).use(input::copyTo) }
        ?: return null
    target.absolutePath
  }.getOrNull()

  private fun receiveIncomingText(intent: Intent?) {
    if (intent == null) return
    if (intent.action == ACTION_OVERLAY_LOOKUP) {
      val text = intent.getStringExtra(TextOverlayService.EXTRA_TEXT)?.trim()
      if (!text.isNullOrEmpty()) {
        if (setsunaWebView == null) pendingOverlayLookup = text
        else dispatchWebEvent("setsuna-mobile-lookup", text)
      }
      return
    }
    val text = when (intent.action) {
      Intent.ACTION_SEND -> intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
      Intent.ACTION_PROCESS_TEXT -> intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
      else -> null
    }?.trim()
    if (text.isNullOrEmpty()) return
    if (setsunaWebView == null) pendingSharedText = text else dispatchIncomingText(text)
  }

  private fun dispatchIncomingText(text: String) {
    dispatchWebEvent("setsuna-mobile-text", text)
  }

  private fun dispatchWebEvent(name: String, text: String) {
    val json = org.json.JSONObject.quote(text)
    setsunaWebView?.post {
      setsunaWebView?.evaluateJavascript(
        "window.dispatchEvent(new CustomEvent('$name', { detail: $json }));",
        null,
      )
    }
  }

  companion object {
    const val ACTION_OVERLAY_LOOKUP = "com.serichka.setsuna.overlay.LOOKUP"
    const val ACTION_OPEN_APP = "com.serichka.setsuna.overlay.OPEN_APP"
    const val REQUEST_DICTIONARIES = 8122
  }
}
