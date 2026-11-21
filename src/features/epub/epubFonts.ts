import type { FontOption } from "../../components/FontPicker";

export interface EpubFontLabels {
    serif: string;
    sans: string;
    yu: string;
    meiryo: string;
    english: boolean;
}

export function buildEpubFontPresets({ serif, sans, yu, meiryo, english }: EpubFontLabels): FontOption[] {
    const L = (en: string, ru: string) => (english ? en : ru);
    return [
        // Japanese reading presets
        {
            value: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif",
            label: serif,
            hint: L("Japanese · Serif", "Японский · с засечками"),
        },
        {
            value: "'Noto Sans JP', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'BIZ UDPGothic', sans-serif",
            label: sans,
            hint: L("Japanese · Sans", "Японский · без засечек"),
        },
        {
            value: "'Yu Gothic UI', 'Yu Gothic', 'Meiryo', sans-serif",
            label: yu,
            hint: L("Japanese · System", "Японский · системный"),
        },
        {
            value: "'Meiryo', 'Yu Gothic UI', sans-serif",
            label: meiryo,
            hint: L("Japanese · System", "Японский · системный"),
        },
        // English & Latin book presets (Google Fonts with graceful local fallbacks)
        {
            value: "'Literata', Georgia, 'Noto Serif JP', serif",
            label: "Literata",
            hint: L("English · Google Books serif", "Английский · книжный (Google Books)"),
        },
        {
            value: "'Newsreader', 'Palatino Linotype', Georgia, 'Noto Serif JP', serif",
            label: "Newsreader",
            hint: L("English · Editorial serif", "Английский · журнальный с курсивом"),
        },
        {
            value: "'EB Garamond', Garamond, Georgia, 'Noto Serif JP', serif",
            label: "EB Garamond",
            hint: L("English · Classic print serif", "Английский · классический печатный"),
        },
        {
            value: "'Lora', Georgia, 'Noto Serif JP', serif",
            label: "Lora",
            hint: L("English · Warm modern serif", "Английский · мягкий книжный"),
        },
        {
            value: "'Source Serif 4', Georgia, 'Noto Serif JP', serif",
            label: "Source Serif 4",
            hint: L("English · Crisp screen serif", "Английский · чёткий экранный"),
        },
        {
            value: "'Inter', 'Segoe UI', 'Noto Sans JP', sans-serif",
            label: "Inter",
            hint: L("English · Clean sans-serif", "Английский · чистый без засечек"),
        },
    ];
}
