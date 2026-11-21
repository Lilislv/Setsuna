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
    const jaGroup = L("Built-in · Japanese", "Предустановленные · японские");
    const enGroup = L("Built-in · English", "Предустановленные · английские");
    return [
        // Japanese reading presets
        {
            value: "'Noto Serif JP', 'Yu Mincho', 'YuMincho', 'Hiragino Mincho ProN', 'BIZ UDPMincho', 'Meiryo', serif",
            label: serif,
            hint: L("Book serif", "Книжный с засечками"),
            script: "ja",
            group: jaGroup,
            sample: "あの日の花 Aa",
        },
        {
            value: "'Noto Sans JP', 'Yu Gothic UI', 'Yu Gothic', 'Meiryo', 'BIZ UDPGothic', sans-serif",
            label: sans,
            hint: L("Clean sans-serif", "Чистый без засечек"),
            script: "ja",
            group: jaGroup,
            sample: "あの日の花 Aa",
        },
        {
            value: "'Yu Gothic UI', 'Yu Gothic', 'Meiryo', sans-serif",
            label: yu,
            hint: L("System sans-serif", "Системный без засечек"),
            script: "ja",
            group: jaGroup,
            sample: "あの日の花 Aa",
        },
        {
            value: "'Meiryo', 'Yu Gothic UI', sans-serif",
            label: meiryo,
            hint: L("System UI sans", "Системный"),
            script: "ja",
            group: jaGroup,
            sample: "あの日の花 Aa",
        },
        // English & Latin book presets (Google Fonts with graceful local fallbacks)
        {
            value: "'Literata', Georgia, 'Noto Serif JP', serif",
            label: "Literata",
            hint: L("Google Books serif", "Книжный (Google Books)"),
            script: "latin",
            group: enGroup,
            sample: "The quick fox Aa",
        },
        {
            value: "'Newsreader', 'Palatino Linotype', Georgia, 'Noto Serif JP', serif",
            label: "Newsreader",
            hint: L("Editorial serif with italics", "Журнальный с курсивом"),
            script: "latin",
            group: enGroup,
            sample: "The quick fox Aa",
        },
        {
            value: "'EB Garamond', Garamond, Georgia, 'Noto Serif JP', serif",
            label: "EB Garamond",
            hint: L("Classic print serif", "Классический печатный"),
            script: "latin",
            group: enGroup,
            sample: "The quick fox Aa",
        },
        {
            value: "'Lora', Georgia, 'Noto Serif JP', serif",
            label: "Lora",
            hint: L("Warm modern serif", "Мягкий книжный"),
            script: "latin",
            group: enGroup,
            sample: "The quick fox Aa",
        },
        {
            value: "'Source Serif 4', Georgia, 'Noto Serif JP', serif",
            label: "Source Serif 4",
            hint: L("Crisp screen serif", "Чёткий экранный"),
            script: "latin",
            group: enGroup,
            sample: "The quick fox Aa",
        },
        {
            value: "'Inter', 'Segoe UI', 'Noto Sans JP', sans-serif",
            label: "Inter",
            hint: L("Clean sans-serif", "Чистый без засечек"),
            script: "latin",
            group: enGroup,
            sample: "The quick fox Aa",
        },
    ];
}
