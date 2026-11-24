package com.serichka.setsuna

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.TensorInfo
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import android.util.Base64
import android.webkit.JavascriptInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.FloatBuffer
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

class MangaOcrBridge(private val activity: Activity) {
    private val modelDir = File(activity.filesDir, "models/manga-ocr")
    private val sessionLock = Any()
    private var ortEnv: OrtEnvironment? = null
    private var encoderSession: OrtSession? = null
    private var decoderSession: OrtSession? = null
    private var vocab: List<String>? = null

    private val isDownloading = AtomicBoolean(false)
    private val downloadCancelled = AtomicBoolean(false)

    private val mlKitClient by lazy {
        TextRecognition.getClient(JapaneseTextRecognizerOptions.Builder().build())
    }

    private val httpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .followRedirects(true)
            .build()
    }

    private data class ModelFileSpec(
        val fileName: String,
        val url: String,
        val fallbackBytes: Long,
    )

    private val modelFiles = listOf(
        ModelFileSpec(
            fileName = "vocab.txt",
            url = "https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/vocab.txt",
            fallbackBytes = 24_072L,
        ),
        ModelFileSpec(
            fileName = "decoder_model_quantized.onnx",
            url = "https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/decoder_model_quantized.onnx",
            fallbackBytes = 29_643_116L,
        ),
        ModelFileSpec(
            fileName = "encoder_model_quantized.onnx",
            url = "https://huggingface.co/kimchireader/manga-ocr-onnx-q8/resolve/main/onnx/encoder_model_quantized.onnx",
            fallbackBytes = 87_007_436L,
        ),
    )

    private fun isModelReady(): Boolean {
        val vocabFile = File(modelDir, "vocab.txt")
        val encFile = File(modelDir, "encoder_model_quantized.onnx")
        val decFile = File(modelDir, "decoder_model_quantized.onnx")
        return vocabFile.isFile && vocabFile.length() > 10_000L &&
            encFile.isFile && encFile.length() > 10_000_000L &&
            decFile.isFile && decFile.length() > 5_000_000L
    }

    private fun modelTotalSizeBytes(): Long {
        if (!modelDir.isDirectory) return 0L
        return modelFiles.sumOf { spec ->
            val f = File(modelDir, spec.fileName)
            if (f.isFile) f.length() else 0L
        }
    }

    @JavascriptInterface
    fun getStatus(): String = wrap {
        JSONObject()
            .put("onnxReady", isModelReady())
            .put("onnxDownloading", isDownloading.get())
            .put("onnxSizeBytes", modelTotalSizeBytes())
            .put("mlkitReady", true)
    }

    @JavascriptInterface
    fun startModelDownload(): String = wrap {
        if (!isDownloading.compareAndSet(false, true)) {
            return@wrap JSONObject().put("started", true).put("alreadyRunning", true)
        }
        downloadCancelled.set(false)
        Thread {
            downloadModelWorker()
        }.start()
        JSONObject().put("started", true)
    }

    @JavascriptInterface
    fun cancelModelDownload(): String = wrap {
        downloadCancelled.set(true)
        JSONObject().put("cancelled", true)
    }

    @JavascriptInterface
    fun deleteModel(): String = wrap {
        downloadCancelled.set(true)
        synchronized(sessionLock) {
            runCatching { encoderSession?.close() }
            runCatching { decoderSession?.close() }
            encoderSession = null
            decoderSession = null
            vocab = null
        }
        if (modelDir.exists()) {
            modelDir.deleteRecursively()
        }
        JSONObject().put("deleted", true)
    }

    private fun emitDownloadProgress(
        status: String,
        file: String,
        downloadedBytes: Long,
        totalBytes: Long,
        error: String? = null,
    ) {
        val percent = if (totalBytes > 0L) {
            ((downloadedBytes.toDouble() / totalBytes.toDouble()) * 100.0).coerceIn(0.0, 100.0)
        } else {
            0.0
        }
        val payload = JSONObject()
            .put("status", status)
            .put("file", file)
            .put("downloadedBytes", downloadedBytes)
            .put("totalBytes", totalBytes)
            .put("percent", percent)
        if (!error.isNullOrBlank()) {
            payload.put("error", error)
        }
        (activity as? MainActivity)?.dispatchWebEvent("setsuna-manga-ocr-download", payload.toString())
    }

    private fun downloadModelWorker() {
        try {
            if (!modelDir.exists()) modelDir.mkdirs()
            val expectedTotal = modelFiles.sumOf { it.fallbackBytes }
            var completedSoFar = 0L

            for (spec in modelFiles) {
                if (downloadCancelled.get()) {
                    emitDownloadProgress("cancelled", spec.fileName, completedSoFar, expectedTotal)
                    return
                }
                val finalFile = File(modelDir, spec.fileName)
                if (finalFile.isFile && finalFile.length() >= (spec.fallbackBytes * 9L / 10L)) {
                    completedSoFar += finalFile.length()
                    emitDownloadProgress("downloading", spec.fileName, completedSoFar, expectedTotal)
                    continue
                }

                val partFile = File(modelDir, "${spec.fileName}.part")
                if (partFile.exists()) partFile.delete()

                val req = Request.Builder()
                    .url(spec.url)
                    .header("User-Agent", "Setsuna-Android/1.0")
                    .build()

                httpClient.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) {
                        throw IllegalStateException("HTTP ${resp.code} downloading ${spec.fileName}")
                    }
                    val body = resp.body ?: throw IllegalStateException("Empty body for ${spec.fileName}")
                    body.byteStream().use { input ->
                        FileOutputStream(partFile).use { output ->
                            val buf = ByteArray(64 * 1024)
                            var fileWritten = 0L
                            var lastEmit = 0L
                            while (true) {
                                if (downloadCancelled.get()) {
                                    throw InterruptedException("Download cancelled")
                                }
                                val read = input.read(buf)
                                if (read < 0) break
                                output.write(buf, 0, read)
                                fileWritten += read
                                val now = SystemClock.elapsedRealtime()
                                if (now - lastEmit >= 150L) {
                                    emitDownloadProgress(
                                        "downloading",
                                        spec.fileName,
                                        completedSoFar + fileWritten,
                                        expectedTotal,
                                    )
                                    lastEmit = now
                                }
                            }
                            completedSoFar += fileWritten
                        }
                    }
                }

                if (finalFile.exists()) finalFile.delete()
                if (!partFile.renameTo(finalFile)) {
                    throw IllegalStateException("Failed to save ${spec.fileName}")
                }
            }

            emitDownloadProgress("done", "", completedSoFar, completedSoFar)
        } catch (err: InterruptedException) {
            emitDownloadProgress("cancelled", "", 0L, modelFiles.sumOf { it.fallbackBytes })
        } catch (err: Exception) {
            emitDownloadProgress(
                "error",
                "",
                0L,
                modelFiles.sumOf { it.fallbackBytes },
                err.message ?: "Model download failed",
            )
        } finally {
            isDownloading.set(false)
        }
    }

    private fun ensureOnnxLoaded() {
        synchronized(sessionLock) {
            if (!isModelReady()) {
                throw IllegalStateException("Offline manga-ocr ONNX model is not downloaded yet.")
            }
            if (ortEnv == null) {
                ortEnv = OrtEnvironment.getEnvironment()
            }
            val env = ortEnv!!
            val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 4)

            if (encoderSession == null) {
                val opts = OrtSession.SessionOptions().apply {
                    setIntraOpNumThreads(threads)
                }
                encoderSession = env.createSession(
                    File(modelDir, "encoder_model_quantized.onnx").absolutePath,
                    opts,
                )
            }
            if (decoderSession == null) {
                val opts = OrtSession.SessionOptions().apply {
                    setIntraOpNumThreads(threads)
                }
                decoderSession = env.createSession(
                    File(modelDir, "decoder_model_quantized.onnx").absolutePath,
                    opts,
                )
            }
            if (vocab == null) {
                vocab = File(modelDir, "vocab.txt").readLines(Charsets.UTF_8)
            }
        }
    }

    private fun decodeBitmapFromBase64(imageBase64: String): Bitmap {
        val commaIdx = imageBase64.indexOf(',')
        val cleanB64 = if (imageBase64.trimStart().startsWith("data:") && commaIdx > 0) {
            imageBase64.substring(commaIdx + 1)
        } else {
            imageBase64
        }
        val bytes = Base64.decode(cleanB64, Base64.DEFAULT)
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: throw IllegalArgumentException("Failed to decode image bytes.")
    }

    @JavascriptInterface
    fun recognizeOnnx(imageBase64: String): String = wrap {
        val t0 = SystemClock.elapsedRealtime()
        ensureOnnxLoaded()

        val rawBitmap = decodeBitmapFromBase64(imageBase64)
        val scaled = if (rawBitmap.width == 224 && rawBitmap.height == 224) {
            rawBitmap
        } else {
            Bitmap.createScaledBitmap(rawBitmap, 224, 224, true).also {
                if (rawBitmap !== it) rawBitmap.recycle()
            }
        }

        val pixels = IntArray(224 * 224)
        scaled.getPixels(pixels, 0, 224, 0, 0, 224, 224)
        scaled.recycle()

        // Match kha-white/manga-ocr: grayscale luminance -> normalized [-1, 1] across 3 NCHW channels
        val planeSize = 224 * 224
        val chw = FloatArray(3 * planeSize)
        for (i in 0 until planeSize) {
            val px = pixels[i]
            val r = (px ushr 16) and 0xFF
            val g = (px ushr 8) and 0xFF
            val b = px and 0xFF
            val gray = (0.299f * r + 0.587f * g + 0.114f * b) / 255.0f
            val norm = (gray - 0.5f) / 0.5f
            chw[i] = norm
            chw[planeSize + i] = norm
            chw[2 * planeSize + i] = norm
        }

        val generatedIds = ArrayList<Long>(32)
        synchronized(sessionLock) {
            val env = ortEnv!!
            val enc = encoderSession!!
            val dec = decoderSession!!

            val encInputName = enc.inputNames.firstOrNull() ?: "pixel_values"
            val encTensor = OnnxTensor.createTensor(
                env,
                FloatBuffer.wrap(chw),
                longArrayOf(1L, 3L, 224L, 224L),
            )
            val encResult: OrtSession.Result = try {
                enc.run(mapOf(encInputName to encTensor))
            } finally {
                encTensor.close()
            }

            encResult.use { er ->
                val encHiddenTensor = er.get(0) as OnnxTensor
                val encShape = (encHiddenTensor.info as TensorInfo).shape
                val encSeqLen = if (encShape.size >= 2) encShape[1].toInt().coerceAtLeast(1) else 197

                val tokens = ArrayList<Long>(64)
                tokens.add(2L) // [CLS] / decoder_start_token_id
                val decInputNames = dec.inputNames
                val needEncoderMask = decInputNames.contains("encoder_attention_mask")
                val needDecoderMask = decInputNames.contains("attention_mask")

                val encoderMaskTensor = if (needEncoderMask) {
                    OnnxTensor.createTensor(
                        env,
                        arrayOf(LongArray(encSeqLen) { 1L }),
                    )
                } else {
                    null
                }

                try {
                    var repeatCount = 0
                    var prevToken = -1L

                    for (step in 0 until 160) {
                        val seqLen = tokens.size
                        val inputIdsTensor = OnnxTensor.createTensor(env, arrayOf(tokens.toLongArray()))
                        val decMaskTensor = if (needDecoderMask) {
                            OnnxTensor.createTensor(env, arrayOf(LongArray(seqLen) { 1L }))
                        } else {
                            null
                        }

                        val feeds = HashMap<String, OnnxTensor>(4)
                        feeds["input_ids"] = inputIdsTensor
                        feeds["encoder_hidden_states"] = encHiddenTensor
                        if (encoderMaskTensor != null) feeds["encoder_attention_mask"] = encoderMaskTensor
                        if (decMaskTensor != null) feeds["attention_mask"] = decMaskTensor

                        var nextId = 3L
                        try {
                            dec.run(feeds).use { dr ->
                                val logitsTensor = dr.get(0) as OnnxTensor
                                val shape = (logitsTensor.info as TensorInfo).shape
                                val vocabSize = shape.last().toInt().coerceAtLeast(1)
                                val fb = logitsTensor.floatBuffer
                                val rowStart = (seqLen - 1) * vocabSize
                                if (rowStart + vocabSize <= fb.capacity()) {
                                    var bestIdx = 0
                                    var bestVal = Float.NEGATIVE_INFINITY
                                    for (v in 0 until vocabSize) {
                                        val score = fb.get(rowStart + v)
                                        if (score > bestVal) {
                                            bestVal = score
                                            bestIdx = v
                                        }
                                    }
                                    nextId = bestIdx.toLong()
                                }
                            }
                        } finally {
                            inputIdsTensor.close()
                            decMaskTensor?.close()
                        }

                        if (nextId == 3L) break // [SEP] / eos_token_id
                        if (nextId == prevToken) {
                            repeatCount += 1
                            if (repeatCount > 8) break
                        } else {
                            repeatCount = 0
                            prevToken = nextId
                        }
                        tokens.add(nextId)
                        generatedIds.add(nextId)
                    }
                } finally {
                    encoderMaskTensor?.close()
                }
            }
        }

        val vocabList = vocab ?: emptyList()
        val text = decodeMangaOcrTokens(generatedIds, vocabList)
        val elapsedMs = (SystemClock.elapsedRealtime() - t0).coerceAtLeast(1L)

        JSONObject()
            .put("text", text)
            .put("engine", "onnx")
            .put("elapsedMs", elapsedMs)
    }

    private fun decodeMangaOcrTokens(ids: List<Long>, vocabList: List<String>): String {
        val sb = StringBuilder()
        for (id in ids) {
            val idx = id.toInt()
            if (idx < 5 || idx >= vocabList.size) continue
            var piece = vocabList[idx]
            if (piece.startsWith("##")) {
                piece = piece.substring(2)
            }
            sb.append(piece)
        }
        return sb.toString().replace("\\s+".toRegex(), "")
    }

    @JavascriptInterface
    fun recognizeMlKit(imageBase64: String): String = wrap {
        val t0 = SystemClock.elapsedRealtime()
        val bmp = decodeBitmapFromBase64(imageBase64)
        try {
            val image = InputImage.fromBitmap(bmp, 0)
            val result = Tasks.await(mlKitClient.process(image), 10, TimeUnit.SECONDS)
            val joined = result.textBlocks
                .joinToString("") { block ->
                    block.text.replace("\\s+".toRegex(), "")
                }
                .trim()
            val elapsedMs = (SystemClock.elapsedRealtime() - t0).coerceAtLeast(1L)
            JSONObject()
                .put("text", joined)
                .put("engine", "mlkit")
                .put("elapsedMs", elapsedMs)
        } finally {
            bmp.recycle()
        }
    }

    @JavascriptInterface
    fun detectPageBlocksMlKit(imageBase64: String): String = wrap {
        val t0 = SystemClock.elapsedRealtime()
        val bmp = decodeBitmapFromBase64(imageBase64)
        try {
            val image = InputImage.fromBitmap(bmp, 0)
            val result = Tasks.await(mlKitClient.process(image), 15, TimeUnit.SECONDS)

            data class DetectedBox(
                val left: Int,
                val top: Int,
                val right: Int,
                val bottom: Int,
                val text: String,
                val vertical: Boolean,
            )

            val boxes = result.textBlocks.mapNotNull { block ->
                val rect = block.boundingBox ?: return@mapNotNull null
                val clean = block.text.replace("\\s+".toRegex(), "").trim()
                if (clean.isEmpty()) return@mapNotNull null
                val l = rect.left.coerceIn(0, bmp.width)
                val t = rect.top.coerceIn(0, bmp.height)
                val r = rect.right.coerceIn(l + 1, bmp.width)
                val b = rect.bottom.coerceIn(t + 1, bmp.height)
                val bw = r - l
                val bh = b - t
                if (bw < 6 || bh < 6) return@mapNotNull null
                DetectedBox(
                    left = l,
                    top = t,
                    right = r,
                    bottom = b,
                    text = clean,
                    vertical = bh.toFloat() > bw.toFloat() * 1.15f,
                )
            }

            // Sort in approximate manga RTL order: group vertical bands, then right-to-left within band
            val bandHeight = (bmp.height * 0.22f).coerceAtLeast(80f)
            val sorted = boxes.sortedWith { a, b ->
                val bandDiff = ((a.top / bandHeight).toInt()) - ((b.top / bandHeight).toInt())
                if (bandDiff != 0 && abs(a.top - b.top) > bandHeight * 0.6f) {
                    a.top.compareTo(b.top)
                } else {
                    b.right.compareTo(a.right)
                }
            }

            val arr = JSONArray()
            for (item in sorted) {
                arr.put(
                    JSONObject()
                        .put("box", JSONArray(listOf(item.left, item.top, item.right, item.bottom)))
                        .put("text", item.text)
                        .put("vertical", item.vertical),
                )
            }
            val elapsedMs = (SystemClock.elapsedRealtime() - t0).coerceAtLeast(1L)
            JSONObject()
                .put("blocks", arr)
                .put("elapsedMs", elapsedMs)
        } finally {
            bmp.recycle()
        }
    }

    private fun wrap(block: () -> Any): String = try {
        JSONObject().put("ok", true).put("value", block()).toString()
    } catch (error: Exception) {
        JSONObject()
            .put("ok", false)
            .put("error", error.message ?: error.javaClass.simpleName)
            .toString()
    }
}
