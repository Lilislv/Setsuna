package com.serichka.setsuna

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class TextCaptureService : Service() {
    private val handler = Handler()
    private val client = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build()
    private var socket: WebSocket? = null
    private var url = ""
    private var retryAttempt = 0
    private var stoppedByUser = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, notification("Waiting for a text source"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action != ACTION_START) return START_NOT_STICKY
        val requestedUrl = intent.getStringExtra(EXTRA_URL)?.trim().orEmpty()
        if (requestedUrl.isEmpty()) return START_NOT_STICKY
        stoppedByUser = false
        if (requestedUrl != url || socket == null) {
            url = requestedUrl
            retryAttempt = 0
            socket?.close(1000, "Replacing connection")
            connect()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stoppedByUser = true
        handler.removeCallbacksAndMessages(null)
        socket?.close(1000, "Stopped")
        socket = null
        saveStatus(false, false, "")
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }

    private fun connect() {
        if (stoppedByUser || url.isEmpty()) return
        saveStatus(true, false, "")
        updateNotification("Connecting to text source")
        socket = client.newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retryAttempt = 0
                saveStatus(true, true, "")
                updateNotification("Receiving text")
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                receivePayload(text)
            }

            override fun onFailure(webSocket: WebSocket, throwable: Throwable, response: Response?) {
                scheduleReconnect(throwable.message ?: "Connection failed")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!stoppedByUser) scheduleReconnect(reason.ifBlank { "Connection closed" })
            }
        })
    }

    private fun scheduleReconnect(error: String) {
        if (stoppedByUser) return
        socket = null
        saveStatus(true, false, error)
        val seconds = intArrayOf(1, 2, 5, 10, 20, 30)[retryAttempt.coerceAtMost(5)]
        retryAttempt += 1
        updateNotification("Reconnecting in ${seconds}s")
        handler.removeCallbacksAndMessages(null)
        handler.postDelayed({ connect() }, seconds * 1000L)
    }

    private fun receivePayload(raw: String) {
        val text = extractText(raw).trim()
        if (text.isEmpty()) return
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString("last_text", "") == text && System.currentTimeMillis() - prefs.getLong("last_text_at", 0) < 800) return
        prefs.edit().putString("last_text", text).putLong("last_text_at", System.currentTimeMillis()).apply()
        sendBroadcast(Intent(ACTION_TEXT).setPackage(packageName).putExtra(EXTRA_TEXT, text))
        if (prefs.getBoolean("overlay_active", false)) {
            val options = prefs.getString("overlay_options", "{}") ?: "{}"
            val intent = Intent(this, TextOverlayService::class.java)
                .setAction(TextOverlayService.ACTION_SHOW)
                .putExtra(TextOverlayService.EXTRA_TEXT, text)
                .putExtra(TextOverlayService.EXTRA_OPTIONS, options)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
        }
    }

    private fun extractText(raw: String): String {
        val trimmed = raw.trim()
        if (!trimmed.startsWith("{")) return raw
        val json = runCatching { JSONObject(trimmed) }.getOrNull() ?: return raw
        listOf("text", "content", "message", "sentence").forEach { key ->
            json.optString(key).takeIf { it.isNotBlank() }?.let { return it }
        }
        val data = json.opt("data")
        if (data is String && data.isNotBlank()) return data
        if (data is JSONObject) {
            listOf("text", "content", "message").forEach { key ->
                data.optString(key).takeIf { it.isNotBlank() }?.let { return it }
            }
        }
        return raw
    }

    private fun saveStatus(running: Boolean, connected: Boolean, error: String) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean("running", running)
            .putBoolean("connected", connected)
            .putString("url", url)
            .putString("error", error)
            .apply()
    }

    private fun notification(text: String) = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("Setsuna text source")
        .setContentText(text)
        .setOngoing(true)
        .build()

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Setsuna text source", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    companion object {
        const val ACTION_START = "com.serichka.setsuna.capture.START"
        const val ACTION_TEXT = "com.serichka.setsuna.capture.TEXT"
        const val EXTRA_URL = "url"
        const val EXTRA_TEXT = "text"
        const val PREFS = "setsuna_capture"
        private const val CHANNEL_ID = "setsuna_capture"
        private const val NOTIFICATION_ID = 8122
    }
}
