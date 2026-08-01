import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getTranslator, type AppLanguage } from "./utils/i18n";
import "./capture-region.css";

type Point = { x: number; y: number };

/// This overlay is its own window and gets no props, so the language comes
/// from the same stored settings the main window writes.
const overlayTranslator = () => {
  let language: AppLanguage = "ru";
  try {
    language = JSON.parse(localStorage.getItem("txthk-settings") || "{}").appLanguage || "ru";
  } catch {
    language = "ru";
  }
  return getTranslator(language);
};

const normalizedRect = (start: Point, end: Point) => ({
  left: Math.min(start.x, end.x),
  top: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
});

function CaptureRegion() {
  const startRef = useRef<Point | null>(null);
  const t = overlayTranslator();
  const [start, setStart] = useState<Point | null>(null);
  const [end, setEnd] = useState<Point | null>(null);
  const [busy, setBusy] = useState(false);

  const cancel = useCallback(() => {
    startRef.current = null;
    setStart(null);
    setEnd(null);
    invoke("cancel_lookup_region_capture").catch(() => {});
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cancel]);

  const finish = async (point: Point) => {
    const initial = startRef.current;
    if (!initial || busy) return;
    const rect = normalizedRect(initial, point);
    startRef.current = null;
    if (rect.width < 8 || rect.height < 8) {
      setStart(null);
      setEnd(null);
      return;
    }

    setBusy(true);
    try {
      const currentWindow = getCurrentWindow();
      const [origin, scaleFactor] = await Promise.all([
        currentWindow.outerPosition(),
        currentWindow.scaleFactor(),
      ]);
      const image = await invoke<string>("finish_lookup_region_capture", {
        x: origin.x + Math.round(rect.left * scaleFactor),
        y: origin.y + Math.round(rect.top * scaleFactor),
        width: Math.max(1, Math.round(rect.width * scaleFactor)),
        height: Math.max(1, Math.round(rect.height * scaleFactor)),
      });
      await emitTo("lookup_external", "lookup_region_selected", { image });
    } catch (error) {
      await emitTo("lookup_external", "lookup_region_failed", { error: String(error) }).catch(() => {});
      await invoke("cancel_lookup_region_capture").catch(() => {});
    } finally {
      setBusy(false);
      setStart(null);
      setEnd(null);
    }
  };

  const rect = start && end ? normalizedRect(start, end) : null;

  return (
    <main
      className="capture-region-root"
      onPointerDown={(event) => {
        if (busy || event.button !== 0) return;
        const point = { x: event.clientX, y: event.clientY };
        startRef.current = point;
        setStart(point);
        setEnd(point);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (startRef.current && !busy) setEnd({ x: event.clientX, y: event.clientY });
      }}
      onPointerUp={(event) => {
        if (startRef.current && !busy) void finish({ x: event.clientX, y: event.clientY });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        cancel();
      }}
    >
      <div className="capture-region-hint">{t("captureRegion.hintImage")} <kbd>Esc</kbd></div>
      {rect && (
        <div
          className="capture-region-selection"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        >
          <span>{Math.round(rect.width)} x {Math.round(rect.height)}</span>
        </div>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<CaptureRegion />);
