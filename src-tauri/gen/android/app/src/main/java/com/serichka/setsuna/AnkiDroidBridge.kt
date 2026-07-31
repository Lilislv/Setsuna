package com.serichka.setsuna

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.util.Base64
import android.webkit.JavascriptInterface
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

class AnkiDroidBridge(private val activity: Activity) {
    private val resolver = activity.contentResolver

    @JavascriptInterface
    fun isAvailable(): String = wrap {
        val packageName = getAnkiDroidPackageName()
        JSONObject()
            .put("available", packageName != null)
            .put("packageName", packageName ?: JSONObject.NULL)
            .put("permissionGranted", hasAnkiPermission())
            .put("specVersion", getSpecVersion())
    }

    @JavascriptInterface
    fun requestPermission(): String = wrap {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !hasAnkiPermission()) {
            ActivityCompat.requestPermissions(activity, arrayOf(READ_WRITE_PERMISSION), 7042)
        }
        JSONObject().put("requested", true).put("permissionGranted", hasAnkiPermission())
    }

    @JavascriptInterface
    fun getDecks(): String = wrap {
        val decks = JSONArray()
        query(DECKS_URI)?.use { cursor ->
            while (cursor.moveToNext()) {
                decks.put(cursor.getString(cursor.requireColumn(DECK_NAME)))
            }
        }
        decks
    }

    @JavascriptInterface
    fun getModels(): String = wrap {
        val models = JSONArray()
        query(MODELS_URI)?.use { cursor ->
            while (cursor.moveToNext()) {
                models.put(cursor.getString(cursor.requireColumn(MODEL_NAME)))
            }
        }
        models
    }

    @JavascriptInterface
    fun getModelFields(modelName: String): String = wrap {
        val model = findModel(modelName) ?: error("AnkiDroid model not found: $modelName")
        JSONArray(model.fields)
    }

    @JavascriptInterface
    fun addNote(noteJson: String): String = wrap {
        if (getAnkiDroidPackageName() == null) {
            error("AnkiDroid is not installed.")
        }
        if (!hasAnkiPermission()) {
            error("Setsuna needs AnkiDroid database permission. Tap the Anki permission request in settings, or allow it in Android app permissions.")
        }

        val note = JSONObject(noteJson)
        val deckName = note.optString("deckName")
        val modelName = note.optString("modelName")
        val fieldsJson = note.optJSONObject("fields") ?: JSONObject()
        val model = findModel(modelName) ?: error("AnkiDroid model not found: $modelName")
        val deckId = findOrCreateDeck(deckName)

        val fields = model.fields.map { fieldName ->
            fieldsJson.optString(fieldName, "")
        }.toMutableList()

        val screenshotField = note.optString("screenshotField", "")
        val screenshotBase64 = note.optString("screenshotBase64", "")
        if (screenshotField.isNotBlank() && screenshotBase64.isNotBlank()) {
            val index = model.fields.indexOf(screenshotField)
            if (index >= 0) {
                val mediaHtml = storeBase64Image(screenshotBase64)
                fields[index] = listOf(fields[index], mediaHtml)
                    .filter { it.isNotBlank() }
                    .joinToString("<br>")
            }
        }

        val values = ContentValues().apply {
            put(NOTE_MID, model.id)
            put(NOTE_FLDS, joinFields(fields))
            val tags = note.optJSONArray("tags")
            if (tags != null && tags.length() > 0) {
                put(NOTE_TAGS, (0 until tags.length()).joinToString(" ") { tags.optString(it) })
            }
        }

        val noteUri = resolver.insert(NOTES_URI, values) ?: error("AnkiDroid rejected the note.")
        moveCardsToDeck(noteUri, deckId)

        JSONObject().put("result", noteUri.lastPathSegment?.toLongOrNull())
    }

    private fun getAnkiDroidPackageName(): String? {
        val provider = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.packageManager.resolveContentProvider(AUTHORITY, PackageManager.ComponentInfoFlags.of(0L))
        } else {
            @Suppress("DEPRECATION")
            activity.packageManager.resolveContentProvider(AUTHORITY, 0)
        }
        return provider?.packageName
    }

    private fun getSpecVersion(): Int {
        val provider = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.packageManager.resolveContentProvider(
                AUTHORITY,
                PackageManager.ComponentInfoFlags.of(PackageManager.GET_META_DATA.toLong()),
            )
        } else {
            @Suppress("DEPRECATION")
            activity.packageManager.resolveContentProvider(AUTHORITY, PackageManager.GET_META_DATA)
        }
        return provider?.metaData?.getInt("com.ichi2.anki.provider.spec") ?: 1
    }

    private fun hasAnkiPermission(): Boolean {
        return ContextCompat.checkSelfPermission(activity, READ_WRITE_PERMISSION) == PackageManager.PERMISSION_GRANTED
    }

    private fun query(uri: Uri): Cursor? {
        return resolver.query(uri, null, null, null, null)
    }

    private fun findModel(name: String): ModelInfo? {
        query(MODELS_URI)?.use { cursor ->
            while (cursor.moveToNext()) {
                val modelName = cursor.getString(cursor.requireColumn(MODEL_NAME))
                if (modelName == name) {
                    return ModelInfo(
                        id = cursor.getLong(cursor.requireColumn(MODEL_ID)),
                        name = modelName,
                        fields = splitFields(cursor.getString(cursor.requireColumn(MODEL_FIELD_NAMES))),
                    )
                }
            }
        }
        return null
    }

    private fun findOrCreateDeck(name: String): Long {
        val safeName = name.ifBlank { "Default" }
        query(DECKS_URI)?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(cursor.requireColumn(DECK_NAME)) == safeName) {
                    return cursor.getLong(cursor.requireColumn(DECK_ID))
                }
            }
        }

        val uri = resolver.insert(DECKS_URI, ContentValues().apply { put(DECK_NAME, safeName) })
            ?: error("Could not create AnkiDroid deck: $safeName")
        return uri.lastPathSegment?.toLongOrNull() ?: error("AnkiDroid returned an invalid deck id.")
    }

    private fun moveCardsToDeck(noteUri: Uri, deckId: Long) {
        val cardsUri = Uri.withAppendedPath(noteUri, "cards")
        query(cardsUri)?.use { cursor ->
            while (cursor.moveToNext()) {
                val ord = cursor.getString(cursor.requireColumn(CARD_ORD))
                val cardUri = Uri.withAppendedPath(cardsUri, ord)
                resolver.update(cardUri, ContentValues().apply { put(CARD_DECK_ID, deckId) }, null, null)
            }
        }
    }

    private fun storeBase64Image(data: String): String {
        val cleaned = data.substringAfter("base64,", data)
        val bytes = Base64.decode(cleaned, Base64.DEFAULT)
        val file = File(activity.cacheDir, "setsuna_screen_${System.currentTimeMillis()}.jpg")
        file.writeBytes(bytes)

        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        val packageName = getAnkiDroidPackageName()
        if (packageName != null) {
            activity.grantUriPermission(packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }

        val mediaUri = resolver.insert(MEDIA_URI, ContentValues().apply {
            put(MEDIA_FILE_URI, uri.toString())
            put(MEDIA_PREFERRED_NAME, file.nameWithoutExtension)
        }) ?: return ""

        val mediaName = File(mediaUri.path ?: file.name).name
        return if (mediaName.isBlank()) "" else """<img src="$mediaName">"""
    }

    private fun wrap(block: () -> Any?): String {
        return try {
            JSONObject().put("ok", true).put("value", block()).toString()
        } catch (error: Throwable) {
            JSONObject()
                .put("ok", false)
                .put("error", error.message ?: error.toString())
                .toString()
        }
    }

    private fun Cursor.requireColumn(name: String): Int {
        val index = getColumnIndex(name)
        if (index < 0) error("AnkiDroid column is missing: $name")
        return index
    }

    private data class ModelInfo(
        val id: Long,
        val name: String,
        val fields: List<String>,
    )

    companion object {
        private const val AUTHORITY = "com.ichi2.anki.flashcards"
        private const val READ_WRITE_PERMISSION = "com.ichi2.anki.permission.READ_WRITE_DATABASE"
        private const val FIELD_SEPARATOR = "\u001f"

        private val AUTHORITY_URI: Uri = Uri.parse("content://$AUTHORITY")
        private val NOTES_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "notes")
        private val MODELS_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "models")
        private val DECKS_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "decks")
        private val MEDIA_URI: Uri = Uri.withAppendedPath(AUTHORITY_URI, "media")

        private const val NOTE_MID = "mid"
        private const val NOTE_FLDS = "flds"
        private const val NOTE_TAGS = "tags"

        private const val MODEL_ID = "_id"
        private const val MODEL_NAME = "name"
        private const val MODEL_FIELD_NAMES = "field_names"

        private const val DECK_ID = "deck_id"
        private const val DECK_NAME = "deck_name"

        private const val CARD_ORD = "ord"
        private const val CARD_DECK_ID = "deck_id"

        private const val MEDIA_FILE_URI = "file_uri"
        private const val MEDIA_PREFERRED_NAME = "preferred_name"

        private fun splitFields(value: String?): List<String> {
            if (value.isNullOrEmpty()) return emptyList()
            return value.split(FIELD_SEPARATOR)
        }

        private fun joinFields(fields: List<String>): String {
            return fields.joinToString(FIELD_SEPARATOR)
        }
    }
}
