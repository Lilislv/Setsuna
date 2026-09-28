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
  override val handleBackNavigation: Boolean = true

  private var setsunaWebView: WebView? = null
  private var pendingSharedText: String? = null
  private var pendingOverlayLookup: String? = null
  private val overlayReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == TextOverlayService.ACTION_DISMISSED) dispatchWebEvent("setsuna-flow-dismissed", "")
    }
  }
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
    ContextCompat.registerReceiver(this, overlayReceiver, IntentFilter(TextOverlayService.ACTION_DISMISSED), ContextCompat.RECEIVER_NOT_EXPORTED)
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
    runCatching { unregisterReceiver(overlayReceiver) }
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
      val paths = mutableListOf<String>()
      val directory = File(cacheDir, "dictionary-imports/" + java.util.UUID.randomUUID().toString()).apply { mkdirs() }
      try {
        uris.forEachIndexed { index, uri -> paths.add(copyDictionaryUri(uri, index, uris.size, directory)) }
        dispatchWebEvent("setsuna-mobile-dictionaries", org.json.JSONArray(paths).toString())
      } catch (error: Exception) {
        paths.forEach { File(it).delete() }
        dispatchWebEvent("setsuna-mobile-dictionaries-copy-failed", error.message ?: "Could not read the selected dictionary files.")
      }
    }.start()
  }

  private fun copyDictionaryUri(uri: android.net.Uri, index: Int, count: Int, directory: File): String {
    var size = 0L
    val displayName = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      if (!cursor.moveToFirst()) null else {
        val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (sizeColumn >= 0 && !cursor.isNull(sizeColumn)) size = cursor.getLong(sizeColumn)
        cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME))
      }
    } ?: "dictionary-${System.currentTimeMillis()}.zip"
    require(listOf(".zip", ".json", ".jsonl", ".gz", ".xz", ".txz", ".ifo", ".idx", ".dict", ".dz", ".csv", ".tsv", ".txt", ".dsl", ".db", ".sqlite", ".sqlite3").any { displayName.endsWith(it, true) }) { "Неподдерживаемый формат: $displayName" }
    val safeName = File(displayName).name
    require(safeName != "." && safeName != "..") { "Invalid filename" }
    require(size <= 0 || directory.usableSpace > size + 32L * 1024 * 1024) { "Недостаточно места для копирования $displayName" }
    val target = File(directory, safeName)
    require(!target.exists()) { "Duplicate filename: $safeName" }
    try {
      val input = contentResolver.openInputStream(uri) ?: error("Не удалось открыть $displayName")
      input.use { source -> FileOutputStream(target).use { output ->
        val buffer = ByteArray(128 * 1024)
        var copied = 0L
        var lastUpdate = 0L
        while (true) {
          val bytes = source.read(buffer)
          if (bytes < 0) break
          output.write(buffer, 0, bytes)
          copied += bytes
          val now = android.os.SystemClock.elapsedRealtime()
          if (now - lastUpdate >= 200) {
            dispatchWebEvent("setsuna-mobile-dictionaries-copy-progress", org.json.JSONObject()
              .put("dict_name", displayName).put("total_dicts", count)
              .put("current_file", index).put("total_files", count).put("words_added", 0)
              .put("percent", if (size > 0) (index + copied.toDouble() / size) * 100 / count else index * 100.0 / count)
              .put("status", "Копирование: ${copied / 1024 / 1024} МБ" + if (size > 0) " / ${size / 1024 / 1024} МБ" else "")
              .toString())
            lastUpdate = now
          }
        }
        require(size <= 0 || copied == size) { "Файл скопирован не полностью: $displayName" }
      } }
      return target.absolutePath
    } catch (error: Exception) {
      target.delete()
      throw error
    }
  }

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
