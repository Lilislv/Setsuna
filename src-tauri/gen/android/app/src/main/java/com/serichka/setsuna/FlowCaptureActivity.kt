package com.serichka.setsuna

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle

class FlowCaptureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE)
    }

    @Deprecated("Deprecated in Android API 35")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_CAPTURE && resultCode == RESULT_OK && data != null) {
            val intent = Intent(this, TextOverlayService::class.java)
                .setAction(TextOverlayService.ACTION_CAPTURE)
                .putExtra(TextOverlayService.EXTRA_CAPTURE_RESULT_CODE, resultCode)
                .putExtra(TextOverlayService.EXTRA_CAPTURE_RESULT_DATA, data)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent) else startService(intent)
        }
        finish()
        overridePendingTransition(0, 0)
    }

    companion object { private const val REQUEST_CAPTURE = 8124 }
}
