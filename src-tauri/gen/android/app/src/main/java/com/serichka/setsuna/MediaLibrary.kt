package com.serichka.setsuna

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import org.json.JSONArray
import org.json.JSONObject

/**
 * Lists a folder picked through the Storage Access Framework the way the
 * desktop library scan does: every directory with videos, its episodes and the
 * subtitle files next to them (subtitle-only subfolders count for the parent).
 */
object MediaLibrary {
    private val VIDEO = setOf(
        "mp4", "mkv", "webm", "avi", "mov", "m4v", "ts", "m2ts", "wmv", "flv", "mpg", "mpeg", "3gp", "ogv",
        "mp3", "m4a", "flac", "ogg", "opus", "wav", "aac",
    )
    private val SUBTITLES = setOf("srt", "ass", "ssa", "vtt", "sub", "sbv", "ttml", "dfxp", "lrc")
    private const val MAX_DEPTH = 6
    private const val MAX_FILES = 6000

    private class Dir(val relative: String) {
        val episodes = JSONArray()
        val subtitles = JSONArray()
        var files = 0
    }

    fun scan(context: Context, treeUri: String): JSONObject {
        val tree = Uri.parse(treeUri)
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootName = displayName(context, DocumentsContract.buildDocumentUriUsingTree(tree, rootId)) ?: "Videos"
        val result = JSONArray()
        var seen = 0

        fun entry(name: String, id: String, size: Long) = JSONObject()
            .put("name", name)
            .put("uri", DocumentsContract.buildDocumentUriUsingTree(tree, id).toString())
            .put("size", size)

        // Returns subtitles that a directory without videos hands to its parent.
        fun walk(documentId: String, relative: String, depth: Int): JSONArray {
            val dir = Dir(relative)
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, documentId)
            val folders = mutableListOf<Pair<String, String>>()
            context.contentResolver.query(
                children,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE,
                ),
                null,
                null,
                null,
            )?.use { cursor ->
                while (cursor.moveToNext() && seen < MAX_FILES) {
                    val id = cursor.getString(0) ?: continue
                    val name = cursor.getString(1) ?: continue
                    val mime = cursor.getString(2) ?: ""
                    val size = if (cursor.isNull(3)) 0L else cursor.getLong(3)
                    if (name.startsWith(".")) continue
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                        folders.add(id to name)
                        continue
                    }
                    seen++
                    val ext = name.substringAfterLast('.', "").lowercase()
                    when {
                        ext in VIDEO -> dir.episodes.put(entry(name, id, size))
                        ext in SUBTITLES -> dir.subtitles.put(entry(name, id, size))
                    }
                }
            }
            if (depth < MAX_DEPTH) {
                for ((id, name) in folders) {
                    val handed = walk(id, if (relative.isEmpty()) name else "$relative/$name", depth + 1)
                    for (index in 0 until handed.length()) {
                        val subtitle = handed.getJSONObject(index)
                        // Keep where it came from so "Subs/Ep01.ass" still matches by name.
                        dir.subtitles.put(subtitle.put("name", "$name/${subtitle.getString("name")}"))
                    }
                }
            }
            if (dir.episodes.length() == 0) return dir.subtitles
            result.put(
                JSONObject()
                    .put("relative", relative)
                    .put("episodes", dir.episodes)
                    .put("subtitles", dir.subtitles),
            )
            return JSONArray()
        }

        walk(rootId, "", 0)
        return JSONObject().put("name", rootName).put("directories", result).put("truncated", seen >= MAX_FILES)
    }

    private fun displayName(context: Context, uri: Uri): String? =
        context.contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
}
