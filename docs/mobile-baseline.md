# Setsuna Mobile Baseline

Дата: 24 августа 2026.

Этот отчёт фиксирует состояние до Mobile 2.0. Значения обновляются только на этапе 0 и не являются обещанием производительности финальной версии.

## Среда

- Устройство: OnePlus CPH2767, Android 16, API 36.
- ADB serial: `3B661W027RW00000`.
- Package: `com.serichka.setsuna`.
- Команда dev-подключения: `npm run android:dev:phone`.
- Smoke-команда: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/android-smoke.ps1`.

## Артефакты

| Метрика | Значение |
| --- | --- |
| Актуальный universal debug APK | `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` |
| Размер APK | 198,353,132 B, около 189.16 MiB |
| SHA-256 APK | `52F4D2EFF3A1D72ACC515D84D85B330E16B77F605E7D9406C414F26F30FC67A1` |
| Установленная Android versionName | `0.0.1` |
| Frontend build | Пройден: `npm.cmd run build` |
| Rust tests | Пройдены: 37 passed, 0 failed |
| Android smoke | Пройден дважды: cold start 221 ms и 238 ms, процесс жив, runtime crash не найден |

## Наблюдения baseline

- APK собран и установлен 24 августа 2026 года.
- `am start -W` вернул `LaunchState: COLD`: первый прогон `TotalTime: 221`, `WaitTime: 223`; второй прогон через npm-скрипт `TotalTime: 238`, `WaitTime: 241`.
- Версия установленного Android package сейчас `0.0.1`, хотя Node/Cargo package указывает `0.1.0`. Это не меняется на этапе 0, но должно быть исправлено до release candidate в отдельной проверке версий.

## Ручные измерения для gate 0

Пользователь на подключённом телефоне проверяет текущую версию, без изменений Mobile 2.0:

1. Открыть Setsuna и убедиться, что нет белого экрана.
2. Открыть ручной lookup и проверить одну японскую строку, одну английскую строку и смешанную строку.
3. Выйти в фон, вернуться, убедиться, что приложение не упало.
4. Открыть Google Drive и AnkiDroid, не меняя данных.

После сообщения пользователя в этот отчёт добавляются фактические cold-start и lookup наблюдения. До этого этап 1 не начинается.

## Результат ручного gate 0

Проверено владельцем проекта 24 августа 2026:

- при ручной вставке в текстовое окно японская строка разбивается на отдельные иероглифы;
- текст из WebSocket на телефоне не принимается;
- Google Drive, Anki и настройки не дают рабочего сценария;
- текущий mobile-дизайн признан непригодным.

Это baseline, а не регрессия этапа 0. Исправления распределены по этапам: общая БД и core (1), сегментация (2), новый mobile shell и настройки (3), ingress (4 и 7), Anki (9), Google Drive (6).
