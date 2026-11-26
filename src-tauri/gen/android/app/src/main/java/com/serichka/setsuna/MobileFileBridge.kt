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
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        activity.runOnUiThread {
            activity.startActivityForResult(intent, MainActivity.REQUEST_DICTIONARIES)
        }
        JSONObject().put("opened", true)
    }

    @JavascriptInterface
    fun selectEpub(): String = wrap {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf(
                    "application/epub+zip",
                    "application/pdf",
                    "application/zip",
                    "application/x-cbz",
                    "application/vnd.comicbook+zip",
                    "application/json",
                    "application/x-fictionbook+xml",
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                    "application/x-mobipocket-ebook",
                    "text/plain",
                    "text/html",
                    "text/markdown",
                    "application/octet-stream",
                ),
            )
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
        }
        activity.runOnUiThread {
            activity.startActivityForResult(intent, MainActivity.REQUEST_EPUB)
        }
        JSONObject().put("opened", true)
    }

    /** Video library: pick a folder once; access is kept across restarts. */
    @JavascriptInterface
    fun selectVideoFolder(): String = wrap {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
        }
        activity.runOnUiThread {
            activity.startActivityForResult(intent, MainActivity.REQUEST_VIDEO_TREE)
        }
        JSONObject().put("opened", true)
    }

    /** Episodes and subtitles of a picked folder (see MediaLibrary). */
    @JavascriptInterface
    fun scanVideoFolder(treeUri: String): String = wrap {
        MediaLibrary.scan(activity, treeUri)
    }

    @JavascriptInterface
    fun forgetVideoFolder(treeUri: String): String = wrap {
        runCatching {
            activity.contentResolver.releasePersistableUriPermission(
                android.net.Uri.parse(treeUri),
                Intent.FLAG_GRANT_READ_URI_PERMISSION,
            )
        }
        JSONObject().put("forgotten", true)
    }

    /** Folders the app may still read (a folder can be revoked in system settings). */
    @JavascriptInterface
    fun videoFolders(): String = wrap {
        val list = org.json.JSONArray()
        activity.contentResolver.persistedUriPermissions
            .filter { it.isReadPermission }
            .forEach { list.put(it.uri.toString()) }
        list
    }

    /** A 127.0.0.1 address the <video> element can stream (with seeking) from. */
    @JavascriptInterface
    fun mediaUrl(documentUri: String): String = wrap {
        MediaServer.urlFor(activity, documentUri)
    }

    /** Small files (subtitles) as base64. */
    @JavascriptInterface
    fun readDocumentBase64(documentUri: String): String = wrap {
        val uri = android.net.Uri.parse(documentUri)
        val bytes = activity.contentResolver.openInputStream(uri)?.use { stream ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            var total = 0
            while (true) {
                val read = stream.read(buffer)
                if (read <= 0) break
                total += read
                if (total > 32 * 1024 * 1024) error("The file is too large for a subtitle.")
                output.write(buffer, 0, read)
            }
            output.toByteArray()
        } ?: error("Could not open the file.")
        Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun cleanupEpub(path: String): String = wrap {
        val directory = java.io.File(activity.cacheDir, "epub-imports").canonicalFile
        val file = java.io.File(path).canonicalFile
        if (file.toPath().startsWith(directory.toPath()) && file != directory && file.isFile) {
            file.delete()
            file.parentFile?.takeIf { it != directory }?.delete()
        }
        JSONObject().put("cleaned", true)
    }

    @JavascriptInterface
    fun setVolumePagingEnabled(enabled: Boolean): String = wrap {
        (activity as? MainActivity)?.volumePagingEnabled = enabled
        JSONObject().put("enabled", enabled)
    }

    @JavascriptInterface
    fun cleanupDictionaries(pathsJson: String): String = wrap {
        val directory = java.io.File(activity.cacheDir, "dictionary-imports").canonicalFile
        val paths = org.json.JSONArray(pathsJson)
        for (index in 0 until paths.length()) {
            val file = java.io.File(paths.getString(index)).canonicalFile
            if (file.toPath().startsWith(directory.toPath()) && file != directory && file.isFile) {
                file.delete()
                file.parentFile?.takeIf { it != directory }?.delete() // only removes empty import folders
            }
        }
        JSONObject().put("cleaned", true)
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
