package com.serichka.setsuna

/** Shared with desktop/in-app lookup; independent of the Activity lifecycle. */
object NativeDictionary {
    init { System.loadLibrary("setsuna_lib") }
    @JvmStatic external fun scan(path: String, sentence: String, cursor: Int): String
    @JvmStatic external fun flowTimer(action: Int): String
}
