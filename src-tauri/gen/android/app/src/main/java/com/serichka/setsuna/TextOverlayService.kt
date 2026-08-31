package com.serichka.setsuna

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.text.Spannable
import android.text.SpannableString
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

class TextOverlayService : Service() {
    private lateinit var windowManager: WindowManager
    private var root: FrameLayout? = null
    private var panel: LinearLayout? = null
    private var label: TextView? = null
    private var title: TextView? = null
    private var openButton: TextView? = null
    private var windowParams: WindowManager.LayoutParams? = null
    private var lastText = ""

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
        startForeground(
            NOTIFICATION_ID,
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle("Setsuna Flow")
                .setContentText("Text overlay is active")
                .setOngoing(true)
                .build(),
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_HIDE) {
            stopSelf()
            return START_NOT_STICKY
        }
        lastText = intent?.getStringExtra(EXTRA_TEXT)?.trim().orEmpty()
        val options = runCatching {
            JSONObject(intent?.getStringExtra(EXTRA_OPTIONS).orEmpty())
        }.getOrElse { JSONObject() }
        ensureOverlay(options)
        updateOverlay(lastText, options)
        return START_STICKY
    }

    override fun onDestroy() {
        root?.let { view -> runCatching { windowManager.removeView(view) } }
        root = null
        panel = null
        label = null
        windowParams = null
        super.onDestroy()
    }

    private fun ensureOverlay(options: JSONObject) {
        if (root != null) return

        val preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val maxWidth = max(dp(220), screenWidth - dp(12))
        val maxHeight = max(dp(110), screenHeight - dp(96))
        val requestedWidth = dp(options.optInt("width", 340).coerceIn(220, 520))
        val requestedHeight = dp(options.optInt("height", 160).coerceIn(110, 360))
        val savedWidth = preferences.getInt("width", requestedWidth).coerceIn(min(dp(220), maxWidth), maxWidth)
        val savedHeight = preferences.getInt("height", requestedHeight).coerceIn(min(dp(110), maxHeight), maxHeight)

        val frame = FrameLayout(this)
        val contentPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            clipToPadding = true
        }
        frame.addView(
            contentPanel,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        val toolbar = FrameLayout(this).apply {
            minimumHeight = dp(36)
            contentDescription = "Drag Setsuna Flow"
        }
        contentPanel.addView(
            toolbar,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(36)),
        )

        val titleView = TextView(this).apply {
            text = "Setsuna Flow"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(48), 0)
        }
        toolbar.addView(
            titleView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        val returnButton = TextView(this).apply {
            text = "↗"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
            gravity = Gravity.CENTER
            contentDescription = "Return to Setsuna"
            isClickable = true
            isFocusable = true
            setOnClickListener { openMainApp() }
        }
        toolbar.addView(
            returnButton,
            FrameLayout.LayoutParams(dp(44), dp(36), Gravity.END or Gravity.TOP),
        )

        val textView = TextView(this).apply {
            setLineSpacing(0f, 1.16f)
            maxLines = Int.MAX_VALUE
            ellipsize = null
            highlightColor = Color.argb(70, 79, 166, 255)
            movementMethod = LinkMovementMethod.getInstance()
            isVerticalScrollBarEnabled = true
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        }
        contentPanel.addView(
            textView,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ),
        )

        val resizeHandle = TextView(this).apply {
            text = "↘"
            setTextColor(Color.argb(220, 225, 230, 240))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            gravity = Gravity.CENTER
            contentDescription = "Resize Setsuna Flow"
        }
        frame.addView(
            resizeHandle,
            FrameLayout.LayoutParams(dp(34), dp(34), Gravity.END or Gravity.BOTTOM),
        )

        val params = WindowManager.LayoutParams(
            savedWidth,
            savedHeight,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = preferences.getInt("x", dp(18)).coerceIn(0, max(0, screenWidth - savedWidth))
            y = preferences.getInt("y", dp(96)).coerceIn(0, max(0, screenHeight - savedHeight))
        }

        var dragDownX = 0f
        var dragDownY = 0f
        var originX = params.x
        var originY = params.y
        toolbar.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    dragDownX = event.rawX
                    dragDownY = event.rawY
                    originX = params.x
                    originY = params.y
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = (originX + (event.rawX - dragDownX).toInt())
                        .coerceIn(0, max(0, screenWidth - params.width))
                    params.y = (originY + (event.rawY - dragDownY).toInt())
                        .coerceIn(0, max(0, screenHeight - params.height))
                    runCatching { windowManager.updateViewLayout(frame, params) }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    preferences.edit().putInt("x", params.x).putInt("y", params.y).apply()
                    true
                }
                else -> false
            }
        }

        var resizeDownX = 0f
        var resizeDownY = 0f
        var resizeStartWidth = savedWidth
        var resizeStartHeight = savedHeight
        resizeHandle.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    resizeDownX = event.rawX
                    resizeDownY = event.rawY
                    resizeStartWidth = params.width
                    resizeStartHeight = params.height
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.width = (resizeStartWidth + (event.rawX - resizeDownX).toInt())
                        .coerceIn(min(dp(220), maxWidth), maxWidth)
                    params.height = (resizeStartHeight + (event.rawY - resizeDownY).toInt())
                        .coerceIn(min(dp(110), maxHeight), maxHeight)
                    params.x = params.x.coerceIn(0, max(0, screenWidth - params.width))
                    params.y = params.y.coerceIn(0, max(0, screenHeight - params.height))
                    runCatching { windowManager.updateViewLayout(frame, params) }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    preferences.edit()
                        .putInt("width", params.width)
                        .putInt("height", params.height)
                        .putInt("x", params.x)
                        .putInt("y", params.y)
                        .apply()
                    true
                }
                else -> false
            }
        }

        root = frame
        panel = contentPanel
        label = textView
        title = titleView
        openButton = returnButton
        windowParams = params
        windowManager.addView(frame, params)
    }

    private fun updateOverlay(text: String, options: JSONObject) {
        applyConfiguredSize(options)
        val textColor = safeColor(options.optString("textColor", "#ffffff"), Color.WHITE)
        val backgroundColor = safeColor(
            options.optString("backgroundColor", "#15181d"),
            Color.rgb(21, 24, 29),
        )
        val opacity = options.optInt("opacity", 88).coerceIn(20, 100)
        val fontSize = options.optInt("fontSize", 22).coerceIn(12, 48)
        val alpha = (opacity * 2.55f).toInt()

        panel?.background = GradientDrawable().apply {
            cornerRadius = dp(12).toFloat()
            setColor(backgroundColor)
            this.alpha = alpha
            setStroke(dp(1), Color.argb(min(210, alpha), 105, 115, 130))
        }
        title?.setTextColor(Color.argb(205, Color.red(textColor), Color.green(textColor), Color.blue(textColor)))
        openButton?.setTextColor(textColor)
        label?.apply {
            this.text = buildOverlayText(text.ifBlank { "Setsuna" }, options)
            setTextColor(textColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSize.toFloat())
            setPadding(dp(14), dp(8), dp(28), dp(12))
        }
    }

    private fun applyConfiguredSize(options: JSONObject) {
        val frame = root ?: return
        val params = windowParams ?: return
        val preferences = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val widthDp = options.optInt("width", 340).coerceIn(220, 520)
        val heightDp = options.optInt("height", 160).coerceIn(110, 360)
        val previousWidthDp = preferences.getInt("configured_width_dp", -1)
        val previousHeightDp = preferences.getInt("configured_height_dp", -1)
        if (previousWidthDp == widthDp && previousHeightDp == heightDp) return

        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        params.width = dp(widthDp).coerceIn(min(dp(220), screenWidth - dp(12)), max(dp(220), screenWidth - dp(12)))
        params.height = dp(heightDp).coerceIn(min(dp(110), screenHeight - dp(96)), max(dp(110), screenHeight - dp(96)))
        params.x = params.x.coerceIn(0, max(0, screenWidth - params.width))
        params.y = params.y.coerceIn(0, max(0, screenHeight - params.height))
        preferences.edit()
            .putInt("configured_width_dp", widthDp)
            .putInt("configured_height_dp", heightDp)
            .putInt("width", params.width)
            .putInt("height", params.height)
            .putInt("x", params.x)
            .putInt("y", params.y)
            .apply()
        runCatching { windowManager.updateViewLayout(frame, params) }
    }

    private fun buildOverlayText(text: String, options: JSONObject): CharSequence {
        val rendered = SpannableString(text)
        val tokens = options.optJSONArray("tokens")
        var searchFrom = 0
        var clickableCount = 0
        if (tokens != null) {
            for (index in 0 until tokens.length()) {
                val token = tokens.optJSONObject(index) ?: continue
                val rawSurface = token.optString("text")
                val start = text.indexOf(rawSurface, searchFrom)
                if (start < 0) continue
                val end = start + rawSurface.length
                searchFrom = end
                if (!token.optBoolean("lookup", false) || rawSurface.isBlank()) continue
                addLookupSpan(rendered, rawSurface, start, end)
                clickableCount += 1
            }
        }
        if (clickableCount == 0) {
            Regex("[A-Za-z\\u00c0-\\u024f][A-Za-z\\u00c0-\\u024f'-]*|[\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff]+")
                .findAll(text)
                .forEach { match ->
                    addLookupSpan(rendered, match.value, match.range.first, match.range.last + 1)
                }
        }
        return rendered
    }

    private fun addLookupSpan(rendered: SpannableString, surface: String, start: Int, end: Int) {
        rendered.setSpan(object : ClickableSpan() {
            override fun onClick(widget: View) = openLookup(surface)

            override fun updateDrawState(drawState: TextPaint) {
                drawState.isUnderlineText = false
                drawState.color = label?.currentTextColor ?: drawState.color
            }
        }, start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    private fun openLookup(text: String) {
        if (text.isBlank()) return
        startActivity(
            Intent(this, MainActivity::class.java)
                .setAction(MainActivity.ACTION_OVERLAY_LOOKUP)
                .putExtra(EXTRA_TEXT, text)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
    }

    private fun openMainApp() {
        startActivity(
            Intent(this, MainActivity::class.java)
                .setAction(MainActivity.ACTION_OPEN_APP)
                .addFlags(
                    Intent.FLAG_ACTIVITY_NEW_TASK or
                        Intent.FLAG_ACTIVITY_SINGLE_TOP or
                        Intent.FLAG_ACTIVITY_REORDER_TO_FRONT,
                ),
        )
    }

    private fun safeColor(value: String, fallback: Int) =
        runCatching { Color.parseColor(value) }.getOrDefault(fallback)

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Setsuna Flow", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    companion object {
        const val ACTION_SHOW = "com.serichka.setsuna.overlay.SHOW"
        const val ACTION_HIDE = "com.serichka.setsuna.overlay.HIDE"
        const val EXTRA_TEXT = "text"
        const val EXTRA_OPTIONS = "options"
        private const val CHANNEL_ID = "setsuna_overlay"
        private const val NOTIFICATION_ID = 8121
        private const val PREFS = "setsuna_overlay"
    }
}
