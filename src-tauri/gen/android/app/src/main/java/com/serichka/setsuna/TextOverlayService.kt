package com.serichka.setsuna

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.text.Spannable
import android.text.SpannableString
import android.text.TextPaint
import android.text.method.LinkMovementMethod
import android.text.style.ClickableSpan
import android.util.Base64
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.min

class TextOverlayService : Service() {
    private lateinit var windowManager: WindowManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private var root: FrameLayout? = null
    private var panel: LinearLayout? = null
    private var label: TextView? = null
    private var title: TextView? = null
    private var settingsRow: LinearLayout? = null
    private var windowParams: WindowManager.LayoutParams? = null
    private var lookupRoot: LinearLayout? = null
    private var lookupParams: WindowManager.LayoutParams? = null
    private var lastText = ""
    private var lastOptions = JSONObject()
    private var currentLookup: NativeLookup? = null
    private var projection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var captureThread: HandlerThread? = null
    private var foregroundReady = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createNotificationChannel()
        foregroundReady = runCatching {
            startOverlayForeground()
            true
        }.getOrElse { error ->
            Log.e(TAG, "Unable to promote Flow to a foreground service", error)
            Toast.makeText(this, "Setsuna Flow: ${error.message ?: error.javaClass.simpleName}", Toast.LENGTH_LONG).show()
            stopSelf()
            false
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!foregroundReady) return START_NOT_STICKY
        return try {
            when (intent?.action) {
                ACTION_HIDE -> {
                    stopSelf()
                    START_NOT_STICKY
                }
                ACTION_CAPTURE -> {
                    val resultCode = intent.getIntExtra(EXTRA_CAPTURE_RESULT_CODE, 0)
                    val resultData = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        intent.getParcelableExtra(EXTRA_CAPTURE_RESULT_DATA, Intent::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(EXTRA_CAPTURE_RESULT_DATA)
                    }
                    if (resultCode != 0 && resultData != null) beginScreenCapture(resultCode, resultData)
                    START_STICKY
                }
                else -> {
                    lastText = intent?.getStringExtra(EXTRA_TEXT)?.trim().orEmpty()
                    lastOptions = runCatching { JSONObject(intent?.getStringExtra(EXTRA_OPTIONS).orEmpty()) }
                        .getOrElse { JSONObject() }
                    ensureOverlay(lastOptions)
                    updateOverlay(lastText, lastOptions)
                    START_STICKY
                }
            }
        } catch (error: Throwable) {
            Log.e(TAG, "Flow overlay failed to start", error)
            getSharedPreferences(TextCaptureService.PREFS, MODE_PRIVATE).edit()
                .putBoolean("overlay_active", false)
                .apply()
            Toast.makeText(this, "Setsuna Flow: ${error.message ?: error.javaClass.simpleName}", Toast.LENGTH_LONG).show()
            stopSelf()
            START_NOT_STICKY
        }
    }

    override fun onDestroy() {
        removeLookup()
        root?.let { view -> runCatching { windowManager.removeView(view) } }
        cleanupCapture()
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
        frame.addView(contentPanel, FrameLayout.LayoutParams(-1, -1))

        val toolbar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(38)
        }
        contentPanel.addView(toolbar, LinearLayout.LayoutParams(-1, dp(38)))

        val titleView = TextView(this).apply {
            text = "FLOW"
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(12), 0, dp(8), 0)
            contentDescription = "Drag Setsuna Flow"
        }
        toolbar.addView(titleView, LinearLayout.LayoutParams(0, -1, 1f))

        val settingsButton = toolbarButton("Aa", "Flow settings") {
            settingsRow?.visibility = if (settingsRow?.visibility == View.VISIBLE) View.GONE else View.VISIBLE
        }
        val returnButton = toolbarButton("\u2197", "Return to Setsuna") { openMainApp() }
        val closeButton = toolbarButton("\u00d7", "Close Setsuna Flow") { stopSelf() }
        toolbar.addView(settingsButton)
        toolbar.addView(returnButton)
        toolbar.addView(closeButton)

        val controls = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            visibility = View.GONE
            setPadding(dp(6), dp(2), dp(6), dp(4))
        }
        controls.addView(controlButton("A-", "Smaller text") { adjustNativeFont(-2) })
        controls.addView(controlButton("A+", "Larger text") { adjustNativeFont(2) })
        controls.addView(controlButton("\u25d0", "Background opacity") { cycleNativeOpacity() })
        controls.addView(controlButton("\u25a3", "Window size") { cycleWindowSize() })
        controls.addView(controlButton("\u21ba", "Use app settings") { resetNativeOverrides() })
        contentPanel.addView(controls, LinearLayout.LayoutParams(-1, dp(38)))

        val textView = TextView(this).apply {
            setLineSpacing(0f, 1.16f)
            maxLines = Int.MAX_VALUE
            ellipsize = null
            highlightColor = Color.argb(80, 79, 166, 255)
            movementMethod = LinkMovementMethod.getInstance()
            isVerticalScrollBarEnabled = true
            overScrollMode = View.OVER_SCROLL_IF_CONTENT_SCROLLS
        }
        contentPanel.addView(textView, LinearLayout.LayoutParams(-1, 0, 1f))

        val resizeHandle = TextView(this).apply {
            text = "\u231f"
            setTextColor(Color.argb(220, 225, 230, 240))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            gravity = Gravity.CENTER
            contentDescription = "Resize Setsuna Flow"
        }
        frame.addView(resizeHandle, FrameLayout.LayoutParams(dp(38), dp(38), Gravity.END or Gravity.BOTTOM))

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

        val dragListener = createDragListener(frame, params)
        titleView.setOnTouchListener(dragListener)
        toolbar.setOnTouchListener(dragListener)
        resizeHandle.setOnTouchListener(createResizeListener(frame, params, savedWidth, savedHeight))

        root = frame
        panel = contentPanel
        label = textView
        title = titleView
        settingsRow = controls
        windowParams = params
        windowManager.addView(frame, params)
    }

    private fun toolbarButton(text: String, description: String, action: () -> Unit) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        gravity = Gravity.CENTER
        contentDescription = description
        isClickable = true
        isFocusable = true
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(dp(42), dp(38))
    }

    private fun controlButton(text: String, description: String, action: () -> Unit) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        gravity = Gravity.CENTER
        contentDescription = description
        isClickable = true
        isFocusable = true
        setTextColor(Color.WHITE)
        background = roundedBackground(Color.argb(80, 255, 255, 255), Color.argb(100, 255, 255, 255), 6)
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(0, dp(31), 1f).apply { marginStart = dp(3); marginEnd = dp(3) }
    }

    private fun createDragListener(frame: View, params: WindowManager.LayoutParams): View.OnTouchListener {
        var downX = 0f
        var downY = 0f
        var originX = 0
        var originY = 0
        return View.OnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    originX = params.x
                    originY = params.y
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val screenWidth = resources.displayMetrics.widthPixels
                    val screenHeight = resources.displayMetrics.heightPixels
                    params.x = (originX + (event.rawX - downX).toInt()).coerceIn(0, max(0, screenWidth - params.width))
                    params.y = (originY + (event.rawY - downY).toInt()).coerceIn(0, max(0, screenHeight - params.height))
                    removeLookup()
                    runCatching { windowManager.updateViewLayout(frame, params) }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("x", params.x).putInt("y", params.y).apply()
                    true
                }
                else -> false
            }
        }
    }

    private fun createResizeListener(
        frame: View,
        params: WindowManager.LayoutParams,
        initialWidth: Int,
        initialHeight: Int,
    ): View.OnTouchListener {
        var downX = 0f
        var downY = 0f
        var startWidth = initialWidth
        var startHeight = initialHeight
        return View.OnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX
                    downY = event.rawY
                    startWidth = params.width
                    startHeight = params.height
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val screenWidth = resources.displayMetrics.widthPixels
                    val screenHeight = resources.displayMetrics.heightPixels
                    params.width = (startWidth + (event.rawX - downX).toInt()).coerceIn(dp(220), max(dp(220), screenWidth - dp(12)))
                    params.height = (startHeight + (event.rawY - downY).toInt()).coerceIn(dp(110), max(dp(110), screenHeight - dp(96)))
                    params.x = params.x.coerceIn(0, max(0, screenWidth - params.width))
                    params.y = params.y.coerceIn(0, max(0, screenHeight - params.height))
                    removeLookup()
                    runCatching { windowManager.updateViewLayout(frame, params) }
                    true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putInt("width", params.width).putInt("height", params.height)
                        .putInt("x", params.x).putInt("y", params.y).apply()
                    true
                }
                else -> false
            }
        }
    }

    private fun updateOverlay(text: String, options: JSONObject) {
        applyConfiguredSize(options)
        val preferences = getSharedPreferences(PREFS, MODE_PRIVATE)
        val manual = preferences.getBoolean("manual_style", false)
        val textColor = safeColor(options.optString("textColor", "#ffffff"), Color.WHITE)
        val backgroundColor = safeColor(options.optString("backgroundColor", "#15181d"), Color.rgb(21, 24, 29))
        val opacity = if (manual) preferences.getInt("opacity", 88) else options.optInt("opacity", 88).coerceIn(20, 100)
        val fontSize = if (manual) preferences.getInt("font_size", 22) else options.optInt("fontSize", 22).coerceIn(12, 48)
        val alpha = (opacity * 2.55f).toInt()

        panel?.background = roundedBackground(backgroundColor, Color.argb(min(210, alpha), 105, 115, 130), 12, alpha)
        title?.setTextColor(Color.argb(210, Color.red(textColor), Color.green(textColor), Color.blue(textColor)))
        settingsRow?.let { row ->
            for (index in 0 until row.childCount) (row.getChildAt(index) as? TextView)?.setTextColor(textColor)
        }
        label?.apply {
            this.text = buildOverlayText(text.ifBlank { "Setsuna" }, options)
            setTextColor(textColor)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSize.toFloat())
            setPadding(dp(14), dp(8), dp(30), dp(12))
        }
    }

    private fun applyConfiguredSize(options: JSONObject) {
        val frame = root ?: return
        val params = windowParams ?: return
        val preferences = getSharedPreferences(PREFS, MODE_PRIVATE)
        val widthDp = options.optInt("width", 340).coerceIn(220, 520)
        val heightDp = options.optInt("height", 160).coerceIn(110, 360)
        val previousWidthDp = preferences.getInt("configured_width_dp", -1)
        val previousHeightDp = preferences.getInt("configured_height_dp", -1)
        if (previousWidthDp == widthDp && previousHeightDp == heightDp) return

        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        params.width = dp(widthDp).coerceIn(dp(220), max(dp(220), screenWidth - dp(12)))
        params.height = dp(heightDp).coerceIn(dp(110), max(dp(110), screenHeight - dp(96)))
        params.x = params.x.coerceIn(0, max(0, screenWidth - params.width))
        params.y = params.y.coerceIn(0, max(0, screenHeight - params.height))
        preferences.edit()
            .putInt("configured_width_dp", widthDp).putInt("configured_height_dp", heightDp)
            .putInt("width", params.width).putInt("height", params.height)
            .putInt("x", params.x).putInt("y", params.y).apply()
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
                val surface = token.optString("text")
                val start = text.indexOf(surface, searchFrom)
                if (start < 0) continue
                val end = start + surface.length
                searchFrom = end
                if (!token.optBoolean("lookup", false) || surface.isBlank()) continue
                addLookupSpan(
                    rendered,
                    surface,
                    token.optString("lookupTerm"),
                    token.optString("lemma"),
                    token.optString("lookupReading").ifBlank { token.optString("reading") },
                    start,
                    end,
                )
                clickableCount += 1
            }
        }
        if (clickableCount == 0) {
            Regex("[A-Za-z\\u00c0-\\u024f][A-Za-z\\u00c0-\\u024f'-]*|[\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff]+")
                .findAll(text)
                .forEach { match -> addLookupSpan(rendered, match.value, "", "", "", match.range.first, match.range.last + 1) }
        }
        return rendered
    }

    private fun addLookupSpan(
        rendered: SpannableString,
        surface: String,
        lookupTerm: String,
        lemma: String,
        reading: String,
        start: Int,
        end: Int,
    ) {
        rendered.setSpan(object : ClickableSpan() {
            override fun onClick(widget: View) = openLookup(surface, lookupTerm, lemma, reading)
            override fun updateDrawState(drawState: TextPaint) {
                drawState.isUnderlineText = false
                drawState.color = Color.rgb(99, 179, 255)
            }
        }, start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }

    private fun openLookup(surface: String, lookupTerm: String, lemma: String, reading: String) {
        if (surface.isBlank()) return
        Thread {
            val result = queryDictionary(surface, lookupTerm, lemma, reading)
            mainHandler.post { showLookup(result) }
        }.start()
    }

    private fun queryDictionary(surface: String, lookupTerm: String, lemma: String, suppliedReading: String): NativeLookup {
        val dbFile = File(applicationInfo.dataDir, "dictionary.db")
        if (!dbFile.exists()) return NativeLookup(surface, lookupTerm.ifBlank { surface }, suppliedReading, emptyList(), "Словари не найдены.")
        return runCatching {
            SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { db ->
                val entries = mutableListOf<NativeEntry>()
                val candidates = linkedSetOf<String>().apply {
                    if (lookupTerm.isNotBlank()) add(lookupTerm)
                    if (lemma.isNotBlank()) add(lemma)
                    add(surface)
                }
                var matchedTerm = lookupTerm.ifBlank { lemma.ifBlank { surface } }
                for (candidate in candidates) {
                    db.rawQuery(
                        "SELECT term, reading, definition, dict_name, tags FROM entries WHERE term = ? OR reading = ? LIMIT 36",
                        arrayOf(candidate, candidate),
                    ).use { cursor ->
                        while (cursor.moveToNext()) {
                            entries += NativeEntry(
                                cursor.getString(0).orEmpty(),
                                cursor.getString(1).orEmpty(),
                                flattenDefinition(cursor.getString(2).orEmpty()),
                                cursor.getString(3).orEmpty().ifBlank { "Dictionary" },
                                cursor.getString(4).orEmpty(),
                            )
                        }
                    }
                    if (entries.isNotEmpty()) {
                        matchedTerm = entries.first().term.ifBlank { candidate }
                        break
                    }
                }
                val reading = entries.firstOrNull()?.reading.orEmpty().ifBlank { suppliedReading }
                NativeLookup(surface, matchedTerm, reading, entries, if (entries.isEmpty()) "Точного совпадения в словарях нет." else "")
            }
        }.getOrElse { NativeLookup(surface, lookupTerm.ifBlank { surface }, suppliedReading, emptyList(), it.message ?: "Ошибка поиска.") }
    }

    private fun flattenDefinition(raw: String): String {
        if (raw.isBlank()) return ""
        return runCatching { flattenJsonValue(org.json.JSONTokener(raw).nextValue()) }
            .getOrElse { raw }
            .replace(Regex("\\s+"), " ")
            .trim()
    }

    private fun flattenJsonValue(value: Any?): String = when (value) {
        null, JSONObject.NULL -> ""
        is String -> value
        is Number, is Boolean -> value.toString()
        is JSONArray -> (0 until value.length()).joinToString("; ") { flattenJsonValue(value.opt(it)) }.trim(';', ' ')
        is JSONObject -> {
            val preferred = listOf("content", "text", "glossary", "definition")
                .firstNotNullOfOrNull { key -> if (value.has(key)) flattenJsonValue(value.opt(key)) else null }
            preferred ?: value.keys().asSequence().map { flattenJsonValue(value.opt(it)) }.filter { it.isNotBlank() }.joinToString("; ")
        }
        else -> value.toString()
    }

    private fun showLookup(result: NativeLookup) {
        removeLookup()
        currentLookup = result
        val main = windowParams ?: return
        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val width = min(max(main.width, dp(286)), screenWidth - dp(12))
        val contentHeight = if (result.entries.isEmpty()) dp(156) else dp(292)
        val height = min(contentHeight, max(dp(150), screenHeight - dp(110)))

        val popup = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(10), dp(16), dp(12))
            background = roundedBackground(Color.rgb(35, 35, 35), Color.rgb(65, 67, 72), 8)
        }
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.TOP
        }
        val wordBlock = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        if (result.reading.isNotBlank() && result.reading != result.headword) {
            wordBlock.addView(TextView(this).apply {
                text = result.reading
                setTextColor(Color.rgb(151, 158, 170))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                includeFontPadding = false
            }, LinearLayout.LayoutParams(-1, dp(18)))
        }
        wordBlock.addView(TextView(this).apply {
            text = result.headword
            setTextColor(Color.rgb(241, 243, 246))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 27f)
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            includeFontPadding = false
        }, LinearLayout.LayoutParams(-1, dp(39)))
        if (result.surface != result.headword) {
            wordBlock.addView(TextView(this).apply {
                text = result.surface
                setTextColor(Color.rgb(154, 161, 172))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                includeFontPadding = false
            }, LinearLayout.LayoutParams(-1, dp(20)))
        }
        header.addView(wordBlock, LinearLayout.LayoutParams(0, -2, 1f))

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = roundedBackground(Color.rgb(27, 28, 30), Color.rgb(62, 65, 70), 6)
        }
        actions.addView(lookupActionButton("+", "Add to Anki", true) { addCurrentLookupToAnki(null) })
        actions.addView(lookupActionButton("+▣", "Add to Anki with screenshot") { requestFlowScreenshot() })
        actions.addView(lookupActionButton("×", "Close lookup", destructive = true) { removeLookup() })
        header.addView(actions, LinearLayout.LayoutParams(-2, dp(38)).apply { topMargin = dp(2) })
        popup.addView(header, LinearLayout.LayoutParams(-1, -2))

        popup.addView(View(this).apply { setBackgroundColor(Color.rgb(57, 58, 62)) },
            LinearLayout.LayoutParams(-1, dp(1)).apply { topMargin = dp(8); bottomMargin = dp(9) })

        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            if (result.entries.isEmpty()) {
                addView(TextView(this@TextOverlayService).apply {
                    text = result.error
                    setTextColor(Color.rgb(185, 190, 199))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                    setLineSpacing(0f, 1.15f)
                    setPadding(0, dp(4), 0, 0)
                })
            } else {
                result.entries.groupBy { it.dictionary }.forEach { (dictionary, entries) ->
                    addView(TextView(this@TextOverlayService).apply {
                        text = dictionary
                        setTextColor(Color.WHITE)
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
                        setTypeface(typeface, android.graphics.Typeface.BOLD)
                        gravity = Gravity.CENTER_VERTICAL
                        setPadding(dp(8), 0, dp(8), 0)
                        background = roundedBackground(dictionaryBadgeColor(dictionary), dictionaryBadgeColor(dictionary), 4)
                    }, LinearLayout.LayoutParams(-2, dp(24)).apply { bottomMargin = dp(6) })

                    val definitions = entries.map { it.definition }.filter { it.isNotBlank() }.distinct()
                    addView(TextView(this@TextOverlayService).apply {
                        text = definitions.mapIndexed { index, definition -> "${index + 1}. $definition" }.joinToString("\n\n")
                        setTextColor(Color.rgb(230, 232, 236))
                        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
                        setLineSpacing(dp(2).toFloat(), 1.12f)
                    }, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(10) })

                    addView(View(this@TextOverlayService).apply { setBackgroundColor(Color.rgb(54, 55, 59)) },
                        LinearLayout.LayoutParams(-1, dp(1)).apply { bottomMargin = dp(10) })
                }
            }
        }
        val scroll = ScrollView(this).apply { addView(body, FrameLayout.LayoutParams(-1, -2)) }
        popup.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))

        val params = WindowManager.LayoutParams(
            width,
            height,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = main.x.coerceIn(0, max(0, screenWidth - width))
            val below = main.y + main.height + dp(8)
            y = if (below + height <= screenHeight) below else max(0, main.y - height - dp(8))
        }
        lookupRoot = popup
        lookupParams = params
        windowManager.addView(popup, params)
    }

    private fun lookupActionButton(
        text: String,
        description: String,
        accent: Boolean = false,
        destructive: Boolean = false,
        action: () -> Unit,
    ) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, if (text.length > 1) 13f else 18f)
        setTextColor(when {
            destructive -> Color.rgb(255, 105, 105)
            else -> Color.rgb(235, 238, 243)
        })
        gravity = Gravity.CENTER
        contentDescription = description
        isClickable = true
        isFocusable = true
        if (accent) background = roundedBackground(Color.rgb(35, 61, 43), Color.rgb(73, 190, 94), 5)
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(dp(39), dp(38))
    }

    private fun dictionaryBadgeColor(dictionary: String): Int {
        val colors = intArrayOf(
            Color.rgb(35, 111, 62),
            Color.rgb(44, 92, 151),
            Color.rgb(146, 66, 34),
            Color.rgb(112, 53, 139),
            Color.rgb(126, 105, 13),
        )
        return colors[(dictionary.hashCode() and Int.MAX_VALUE) % colors.size]
    }

    private fun removeLookup() {
        lookupRoot?.let { runCatching { windowManager.removeView(it) } }
        lookupRoot = null
        lookupParams = null
        currentLookup = null
    }

    private fun addCurrentLookupToAnki(screenshotBase64: String?) {
        val lookup = currentLookup ?: return
        Thread {
            val message = runCatching { addAnkiNote(lookup, screenshotBase64) }
                .fold({ "Added to AnkiDroid" }, { it.message ?: "AnkiDroid error" })
            mainHandler.post { Toast.makeText(this, message, Toast.LENGTH_LONG).show() }
        }.start()
    }

    private fun addAnkiNote(lookup: NativeLookup, screenshotBase64: String?) {
        val deckName = lastOptions.optString("ankiDeck").ifBlank { error("Choose an Anki deck for this window in Setsuna.") }
        val modelName = lastOptions.optString("ankiModel").ifBlank { error("Choose an Anki model in Setsuna.") }
        val fields = findAnkiModel(modelName) ?: error("AnkiDroid model not found: $modelName")
        val deckId = findOrCreateAnkiDeck(deckName)
        val values = MutableList(fields.names.size) { "" }
        fun put(fieldKey: String, value: String) {
            val fieldName = lastOptions.optString(fieldKey)
            val index = fields.names.indexOf(fieldName)
            if (index >= 0) values[index] = value
        }
        put("ankiFieldWord", lookup.headword)
        put("ankiFieldReading", lookup.reading)
        put("ankiFieldMeaning", lookup.entries.map { it.definition }.filter { it.isNotBlank() }.distinct().joinToString("<br>"))
        put("ankiFieldSentence", lastText)
        put("ankiFieldDict", lookup.entries.map { it.dictionary }.distinct().joinToString(", "))
        if (!screenshotBase64.isNullOrBlank()) {
            put("ankiFieldScreenshot", storeAnkiImage(screenshotBase64))
        }
        val noteUri = contentResolver.insert(ANKI_NOTES_URI, ContentValues().apply {
            put("mid", fields.id)
            put("flds", values.joinToString("\u001f"))
        }) ?: error("AnkiDroid rejected the note.")
        contentResolver.query(Uri.withAppendedPath(noteUri, "cards"), null, null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                val ord = cursor.getString(cursor.requireColumn("ord"))
                contentResolver.update(
                    Uri.withAppendedPath(Uri.withAppendedPath(noteUri, "cards"), ord),
                    ContentValues().apply { put("deck_id", deckId) },
                    null,
                    null,
                )
            }
        }
    }

    private fun findAnkiModel(name: String): AnkiModel? {
        contentResolver.query(ANKI_MODELS_URI, null, null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(cursor.requireColumn("name")) == name) {
                    return AnkiModel(
                        cursor.getLong(cursor.requireColumn("_id")),
                        cursor.getString(cursor.requireColumn("field_names")).orEmpty().split("\u001f"),
                    )
                }
            }
        }
        return null
    }

    private fun findOrCreateAnkiDeck(name: String): Long {
        contentResolver.query(ANKI_DECKS_URI, null, null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) {
                if (cursor.getString(cursor.requireColumn("deck_name")) == name) return cursor.getLong(cursor.requireColumn("deck_id"))
            }
        }
        val uri = contentResolver.insert(ANKI_DECKS_URI, ContentValues().apply { put("deck_name", name) })
            ?: error("Could not create AnkiDroid deck: $name")
        return uri.lastPathSegment?.toLongOrNull() ?: error("AnkiDroid returned an invalid deck id.")
    }

    private fun storeAnkiImage(encoded: String): String {
        val bytes = Base64.decode(encoded.substringAfter("base64,", encoded), Base64.DEFAULT)
        val file = File(cacheDir, "setsuna_flow_${System.currentTimeMillis()}.jpg").apply { writeBytes(bytes) }
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        packageManager.resolveContentProvider(ANKI_AUTHORITY, 0)?.packageName?.let { packageName ->
            grantUriPermission(packageName, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val mediaUri = contentResolver.insert(ANKI_MEDIA_URI, ContentValues().apply {
            put("file_uri", uri.toString())
            put("preferred_name", file.nameWithoutExtension)
        }) ?: return ""
        val mediaName = File(mediaUri.path ?: file.name).name
        return if (mediaName.isBlank()) "" else "<img src=\"$mediaName\">"
    }

    private fun requestFlowScreenshot() {
        startActivity(Intent(this, FlowCaptureActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun beginScreenCapture(resultCode: Int, resultData: Intent) {
        promoteForScreenCapture()
        root?.visibility = View.INVISIBLE
        lookupRoot?.visibility = View.INVISIBLE
        val metrics = resources.displayMetrics
        val reader = ImageReader.newInstance(metrics.widthPixels, metrics.heightPixels, PixelFormat.RGBA_8888, 2)
        val thread = HandlerThread("setsuna-flow-capture").apply { start() }
        val handler = Handler(thread.looper)
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val mediaProjection = manager.getMediaProjection(resultCode, resultData) ?: run {
            reader.close()
            thread.quitSafely()
            root?.visibility = View.VISIBLE
            lookupRoot?.visibility = View.VISIBLE
            Toast.makeText(this, "Unable to start screen capture.", Toast.LENGTH_LONG).show()
            return
        }
        projection = mediaProjection
        imageReader = reader
        captureThread = thread
        mediaProjection.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() = cleanupCapture()
        }, handler)
        reader.setOnImageAvailableListener({ source ->
            val image = source.acquireLatestImage() ?: return@setOnImageAvailableListener
            try {
                val plane = image.planes[0]
                val rowPadding = plane.rowStride - plane.pixelStride * metrics.widthPixels
                val bitmap = Bitmap.createBitmap(metrics.widthPixels + rowPadding / plane.pixelStride, metrics.heightPixels, Bitmap.Config.ARGB_8888)
                bitmap.copyPixelsFromBuffer(plane.buffer)
                val cropped = Bitmap.createBitmap(bitmap, 0, 0, metrics.widthPixels, metrics.heightPixels)
                val output = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, 88, output)
                bitmap.recycle()
                if (cropped !== bitmap) cropped.recycle()
                val encoded = Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
                mainHandler.post {
                    root?.visibility = View.VISIBLE
                    lookupRoot?.visibility = View.VISIBLE
                    addCurrentLookupToAnki(encoded)
                    cleanupCapture()
                }
            } finally {
                image.close()
            }
        }, handler)
        virtualDisplay = mediaProjection.createVirtualDisplay(
            "SetsunaFlowCapture",
            metrics.widthPixels,
            metrics.heightPixels,
            metrics.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            handler,
        )
        handler.postDelayed({
            if (imageReader != null) mainHandler.post {
                root?.visibility = View.VISIBLE
                lookupRoot?.visibility = View.VISIBLE
                Toast.makeText(this, "Screenshot capture timed out.", Toast.LENGTH_LONG).show()
                cleanupCapture()
            }
        }, 5000)
    }

    private fun cleanupCapture() {
        runCatching { virtualDisplay?.release() }
        runCatching { imageReader?.close() }
        runCatching { projection?.stop() }
        virtualDisplay = null
        imageReader = null
        projection = null
        captureThread?.quitSafely()
        captureThread = null
    }

    private fun promoteForScreenCapture() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(
                NOTIFICATION_ID,
                notification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION,
            )
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        } else {
            startForeground(NOTIFICATION_ID, notification())
        }
    }

    private fun startOverlayForeground() {
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> startForeground(
                NOTIFICATION_ID,
                notification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
            )
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> startForeground(
                NOTIFICATION_ID,
                notification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE,
            )
            else -> startForeground(NOTIFICATION_ID, notification())
        }
    }

    private fun adjustNativeFont(delta: Int) {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val current = if (prefs.getBoolean("manual_style", false)) prefs.getInt("font_size", 22) else lastOptions.optInt("fontSize", 22)
        prefs.edit().putBoolean("manual_style", true).putInt("font_size", (current + delta).coerceIn(12, 48)).apply()
        updateOverlay(lastText, lastOptions)
    }

    private fun cycleNativeOpacity() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        val current = if (prefs.getBoolean("manual_style", false)) prefs.getInt("opacity", 88) else lastOptions.optInt("opacity", 88)
        val next = when { current > 80 -> 65; current > 50 -> 35; else -> 95 }
        prefs.edit().putBoolean("manual_style", true).putInt("opacity", next).apply()
        updateOverlay(lastText, lastOptions)
    }

    private fun cycleWindowSize() {
        val frame = root ?: return
        val params = windowParams ?: return
        val screenWidth = resources.displayMetrics.widthPixels
        val screenHeight = resources.displayMetrics.heightPixels
        val compact = params.width > screenWidth * 0.72
        params.width = if (compact) min(dp(300), screenWidth - dp(12)) else min(dp(420), screenWidth - dp(12))
        params.height = if (compact) min(dp(150), screenHeight - dp(96)) else min(dp(240), screenHeight - dp(96))
        params.x = params.x.coerceIn(0, max(0, screenWidth - params.width))
        params.y = params.y.coerceIn(0, max(0, screenHeight - params.height))
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putInt("width", params.width).putInt("height", params.height).apply()
        removeLookup()
        windowManager.updateViewLayout(frame, params)
    }

    private fun resetNativeOverrides() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean("manual_style", false).apply()
        updateOverlay(lastText, lastOptions)
    }

    private fun openMainApp() {
        startActivity(Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_APP)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
    }

    private fun roundedBackground(color: Int, stroke: Int, radiusDp: Int, alpha: Int = 255) = GradientDrawable().apply {
        cornerRadius = dp(radiusDp).toFloat()
        setColor(color)
        this.alpha = alpha
        setStroke(dp(1), stroke)
    }

    private fun safeColor(value: String, fallback: Int) = runCatching { Color.parseColor(value) }.getOrDefault(fallback)
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun Cursor.requireColumn(name: String): Int {
        val index = getColumnIndex(name)
        if (index < 0) error("AnkiDroid column is missing: $name")
        return index
    }

    private fun notification(): Notification = NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(R.mipmap.ic_launcher)
        .setContentTitle("Setsuna Flow")
        .setContentText("Text overlay is active")
        .setOngoing(true)
        .build()

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Setsuna Flow", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    private data class NativeEntry(
        val term: String,
        val reading: String,
        val definition: String,
        val dictionary: String,
        val tags: String,
    )
    private data class NativeLookup(
        val surface: String,
        val headword: String,
        val reading: String,
        val entries: List<NativeEntry>,
        val error: String,
    )
    private data class AnkiModel(val id: Long, val names: List<String>)

    companion object {
        private const val TAG = "SetsunaFlow"
        const val ACTION_SHOW = "com.serichka.setsuna.overlay.SHOW"
        const val ACTION_HIDE = "com.serichka.setsuna.overlay.HIDE"
        const val ACTION_CAPTURE = "com.serichka.setsuna.overlay.CAPTURE"
        const val EXTRA_TEXT = "text"
        const val EXTRA_OPTIONS = "options"
        const val EXTRA_CAPTURE_RESULT_CODE = "captureResultCode"
        const val EXTRA_CAPTURE_RESULT_DATA = "captureResultData"
        private const val CHANNEL_ID = "setsuna_overlay"
        private const val NOTIFICATION_ID = 8121
        private const val PREFS = "setsuna_overlay"
        private const val ANKI_AUTHORITY = "com.ichi2.anki.flashcards"
        private val ANKI_ROOT = Uri.parse("content://$ANKI_AUTHORITY")
        private val ANKI_NOTES_URI = Uri.withAppendedPath(ANKI_ROOT, "notes")
        private val ANKI_MODELS_URI = Uri.withAppendedPath(ANKI_ROOT, "models")
        private val ANKI_DECKS_URI = Uri.withAppendedPath(ANKI_ROOT, "decks")
        private val ANKI_MEDIA_URI = Uri.withAppendedPath(ANKI_ROOT, "media")
    }
}
