package com.serichka.setsuna

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.FileInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Streams videos from folders picked through the Storage Access Framework
 * (content:// URIs) to the WebView's <video>. Listens on 127.0.0.1 only, needs
 * a per-run random token, and answers HTTP Range requests so seeking works
 * without copying multi-gigabyte episodes.
 */
object MediaServer {
    private val token: String = UUID.randomUUID().toString().replace("-", "")
    private val pool = Executors.newCachedThreadPool { runnable ->
        Thread(runnable, "setsuna-media-client").apply { isDaemon = true }
    }
    @Volatile private var server: ServerSocket? = null
    @Volatile private var appContext: Context? = null

    @Synchronized
    private fun port(context: Context): Int {
        appContext = context.applicationContext
        server?.let { if (!it.isClosed) return it.localPort }
        val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        server = socket
        Thread({ acceptLoop(socket) }, "setsuna-media-server").apply { isDaemon = true }.start()
        return socket.localPort
    }

    fun urlFor(context: Context, documentUri: String): String =
        "http://127.0.0.1:${port(context)}/m/$token?u=" + URLEncoder.encode(documentUri, "UTF-8")

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                break
            }
            pool.execute { handle(client) }
        }
    }

    private val cors = mapOf(
        "Access-Control-Allow-Origin" to "*",
        "Access-Control-Allow-Headers" to "Range",
        "Access-Control-Expose-Headers" to "Content-Length, Content-Range, Accept-Ranges",
    )

    private fun handle(client: Socket) {
        try {
            client.use { socket ->
                socket.soTimeout = 60_000
                val input = BufferedInputStream(socket.getInputStream())
                val out = BufferedOutputStream(socket.getOutputStream(), 64 * 1024)
                val requestLine = readLine(input) ?: return
                val headers = HashMap<String, String>()
                while (true) {
                    val line = readLine(input) ?: break
                    if (line.isEmpty()) break
                    val colon = line.indexOf(':')
                    if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
                }
                val parts = requestLine.split(" ")
                if (parts.size < 2) return
                val method = parts[0].uppercase()
                if (method == "OPTIONS") {
                    writeHead(out, 204, "No Content", cors + mapOf("Access-Control-Allow-Methods" to "GET, HEAD, OPTIONS", "Content-Length" to "0"))
                    out.flush()
                    return
                }
                val target = parts[1]
                if (target.substringBefore('?') != "/m/$token" || (method != "GET" && method != "HEAD")) {
                    writeHead(out, 404, "Not Found", cors + mapOf("Content-Length" to "0"))
                    out.flush()
                    return
                }
                val encoded = target.substringAfter('?', "").split('&').firstOrNull { it.startsWith("u=") }?.substring(2)
                val context = appContext
                if (encoded == null || context == null) {
                    writeHead(out, 400, "Bad Request", cors + mapOf("Content-Length" to "0"))
                    out.flush()
                    return
                }
                serve(context, Uri.parse(URLDecoder.decode(encoded, "UTF-8")), method == "HEAD", headers["range"], out)
            }
        } catch (_: IOException) {
            // The player dropped the connection (seek, pause, next episode): nothing to do.
        } catch (_: SecurityException) {
            // Folder access was revoked; the request just fails.
        }
    }

    private fun serve(context: Context, uri: Uri, headOnly: Boolean, range: String?, out: OutputStream) {
        val descriptor = context.contentResolver.openAssetFileDescriptor(uri, "r")
        if (descriptor == null) {
            writeHead(out, 404, "Not Found", cors + mapOf("Content-Length" to "0"))
            out.flush()
            return
        }
        descriptor.use { afd ->
            val total = if (afd.length >= 0) afd.length else sizeOf(context, uri)
            val mime = context.contentResolver.getType(uri)?.takeIf { it != "application/octet-stream" }
                ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(uri.lastPathSegment.orEmpty().substringAfterLast('.', "").lowercase())
                ?: "video/mp4"
            var start = 0L
            var end = if (total > 0) total - 1 else -1L
            var partial = false
            val match = range?.let { Regex("bytes=(\\d*)-(\\d*)").find(it) }
            if (match != null && total > 0) {
                val (from, to) = match.destructured
                if (from.isEmpty() && to.isNotEmpty()) {
                    start = (total - to.toLong()).coerceAtLeast(0)
                } else {
                    start = from.toLongOrNull() ?: 0L
                    if (to.isNotEmpty()) end = minOf(to.toLong(), total - 1)
                }
                if (start >= total) {
                    writeHead(out, 416, "Range Not Satisfiable", cors + mapOf("Content-Range" to "bytes */$total", "Content-Length" to "0"))
                    out.flush()
                    return
                }
                partial = true
            }
            val length = if (end >= start) end - start + 1 else -1L
            val head = LinkedHashMap<String, String>()
            head.putAll(cors)
            head["Content-Type"] = mime
            head["Accept-Ranges"] = "bytes"
            head["Cache-Control"] = "no-store"
            if (length >= 0) head["Content-Length"] = length.toString()
            if (partial) head["Content-Range"] = "bytes $start-$end/$total"
            writeHead(out, if (partial) 206 else 200, if (partial) "Partial Content" else "OK", head)
            if (headOnly) {
                out.flush()
                return
            }
            FileInputStream(afd.fileDescriptor).use { stream ->
                stream.channel.position(afd.startOffset + start)
                val buffer = ByteArray(256 * 1024)
                var remaining = if (length >= 0) length else Long.MAX_VALUE
                while (remaining > 0) {
                    val read = stream.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                    if (read <= 0) break
                    out.write(buffer, 0, read)
                    remaining -= read
                }
            }
            out.flush()
        }
    }

    private fun sizeOf(context: Context, uri: Uri): Long =
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else -1L
        } ?: -1L

    private fun writeHead(out: OutputStream, status: Int, reason: String, headers: Map<String, String>) {
        val builder = StringBuilder("HTTP/1.1 $status $reason\r\n")
        headers.forEach { (name, value) -> builder.append(name).append(": ").append(value).append("\r\n") }
        builder.append("Connection: close\r\n\r\n")
        out.write(builder.toString().toByteArray(Charsets.ISO_8859_1))
    }

    private fun readLine(input: InputStream): String? {
        val bytes = java.io.ByteArrayOutputStream()
        while (true) {
            val value = input.read()
            if (value < 0) return if (bytes.size() == 0) null else bytes.toString("ISO-8859-1")
            if (value == '\n'.code) break
            if (value != '\r'.code) bytes.write(value)
            if (bytes.size() > 16 * 1024) throw IOException("Header line too long")
        }
        return bytes.toString("ISO-8859-1")
    }
}
