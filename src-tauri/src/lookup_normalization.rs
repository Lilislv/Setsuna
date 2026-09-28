const MAX_LOOKUP_VARIANTS: usize = 8;

fn normalize_kana(text: &str) -> String {
    static MAPPING: std::sync::OnceLock<std::collections::HashMap<String, String>> = std::sync::OnceLock::new();
    let mapping = MAPPING.get_or_init(|| serde_json::from_str(include_str!("yomitan-kana.json")).expect("vendored kana mappings"));
    let mut chars = text.chars().peekable();
    let mut output = String::new();
    while let Some(character) = chars.next() {
        if let Some(next) = chars.peek() {
            let pair = format!("{character}{next}");
            if let Some(replacement) = mapping.get(&pair) {
                output.push_str(replacement);
                chars.next();
                continue;
            }
        }
        match mapping.get(&character.to_string()) {
            Some(replacement) => output.push_str(replacement),
            None => output.push(character),
        }
    }
    output
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn prolonged_hiragana(previous: char) -> Option<char> {
    let vowel = match previous {
        'ぁ' | 'あ' | 'か' | 'が' | 'さ' | 'ざ' | 'た' | 'だ' | 'な' | 'は' | 'ば' | 'ぱ'
        | 'ま' | 'ゃ' | 'や' | 'ら' | 'ゎ' | 'わ' => 'あ',
        'ぃ' | 'い' | 'き' | 'ぎ' | 'し' | 'じ' | 'ち' | 'ぢ' | 'に' | 'ひ' | 'び' | 'ぴ'
        | 'み' | 'り' | 'ゐ' => 'い',
        'ぅ' | 'う' | 'く' | 'ぐ' | 'す' | 'ず' | 'っ' | 'つ' | 'づ' | 'ぬ' | 'ふ' | 'ぶ'
        | 'ぷ' | 'む' | 'ゅ' | 'ゆ' | 'る' | 'ゔ' => 'う',
        'ぇ' | 'え' | 'け' | 'げ' | 'せ' | 'ぜ' | 'て' | 'で' | 'ね' | 'へ' | 'べ' | 'ぺ'
        | 'め' | 'れ' | 'ゑ' => 'え',
        'ぉ' | 'お' | 'こ' | 'ご' | 'そ' | 'ぞ' | 'と' | 'ど' | 'の' | 'ほ' | 'ぼ' | 'ぽ'
        | 'も' | 'ょ' | 'よ' | 'ろ' | 'を' => 'う',
        _ => return None,
    };
    Some(vowel)
}

pub(crate) fn katakana_to_hiragana(text: &str, expand_prolonged_marks: bool) -> String {
    let mut output = String::with_capacity(text.len());
    let mut previous = None;

    for character in text.chars() {
        let code_point = character as u32;
        let mut normalized = if (0x30a1..=0x30f4).contains(&code_point) {
            char::from_u32(code_point - 0x60).unwrap_or(character)
        } else {
            character
        };

        if character == 'ー' && expand_prolonged_marks {
            if let Some(vowel) = previous.and_then(prolonged_hiragana) {
                normalized = vowel;
            }
        }

        output.push(normalized);
        previous = Some(normalized);
    }

    output
}

pub(crate) fn hiragana_to_katakana(text: &str) -> String {
    text.chars()
        .map(|character| {
            let code_point = character as u32;
            if (0x3041..=0x3096).contains(&code_point) {
                char::from_u32(code_point + 0x60).unwrap_or(character)
            } else {
                character
            }
        })
        .collect()
}

fn collapse_emphatic_sequences(text: &str, remove_all: bool) -> String {
    let chars: Vec<char> = text.chars().collect();
    let is_emphatic = |character: char| matches!(character, 'っ' | 'ッ' | 'ー');
    let first_plain = chars.iter().position(|character| !is_emphatic(*character));
    let last_plain = chars.iter().rposition(|character| !is_emphatic(*character));
    let (Some(first_plain), Some(last_plain)) = (first_plain, last_plain) else {
        return text.to_string();
    };

    let mut output = String::with_capacity(text.len());
    output.extend(chars[..first_plain].iter().copied());
    let mut previous_emphatic = None;
    for character in chars[first_plain..=last_plain].iter().copied() {
        if is_emphatic(character) {
            if remove_all {
                continue;
            }
            if previous_emphatic == Some(character) {
                continue;
            }
            previous_emphatic = Some(character);
        } else {
            previous_emphatic = None;
        }
        output.push(character);
    }
    output.extend(chars[last_plain + 1..].iter().copied());
    output
}

fn has_repeated_emphatic_sequence(text: &str) -> bool {
    let mut previous = None;
    for character in text.chars() {
        if matches!(character, 'っ' | 'ッ' | 'ー') {
            if previous == Some(character) {
                return true;
            }
            previous = Some(character);
        } else {
            previous = None;
        }
    }
    false
}

fn expand_small_yoon(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            'ゃ' => 'や',
            'ゅ' => 'ゆ',
            'ょ' => 'よ',
            'ャ' => 'ヤ',
            'ュ' => 'ユ',
            'ョ' => 'ヨ',
            _ => character,
        })
        .collect()
}

pub(crate) fn japanese_lookup_variants(text: &str) -> Vec<String> {
    let mut variants = Vec::with_capacity(MAX_LOOKUP_VARIANTS);
    push_unique(&mut variants, text.to_string());
    let normalized = normalize_kana(text);
    push_unique(&mut variants, normalized.clone());
    let hiragana = katakana_to_hiragana(&normalized, false);
    push_unique(&mut variants, hiragana.clone());

    let expanded_hiragana = katakana_to_hiragana(&normalized, true);
    push_unique(&mut variants, expanded_hiragana.clone());
    push_unique(&mut variants, hiragana_to_katakana(&normalized));
    if has_repeated_emphatic_sequence(&hiragana) {
        push_unique(&mut variants, collapse_emphatic_sequences(&hiragana, false));
        push_unique(&mut variants, collapse_emphatic_sequences(&hiragana, true));
    }

    // Some imported dictionaries use full-size yoon in historical or loose
    // readings (じゆう), while the source uses contracted kana (じゅー).
    // Keep this low-priority variant; exact and standard readings stay first.
    if text.ends_with('ー') {
        let expanded_yoon = expand_small_yoon(&expanded_hiragana);
        push_unique(&mut variants, expanded_yoon.clone());
        push_unique(&mut variants, hiragana_to_katakana(&expanded_yoon));
    }

    variants.truncate(MAX_LOOKUP_VARIANTS);
    variants
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_halfwidth_and_combining_kana_without_changing_small_ke() {
        assert!(japanese_lookup_variants("ﾀﾍﾞﾀ").contains(&"たべた".to_string()));
        assert!(japanese_lookup_variants("か\u{3099}く").contains(&"がく".to_string()));
        assert_eq!(katakana_to_hiragana("ヶ丘", false), "ヶ丘");
    }

    #[test]
    fn expands_prolonged_hiragana_vowels() {
        assert_eq!(katakana_to_hiragana("じゅー", true), "じゅう");
        assert_eq!(katakana_to_hiragana("リバー", true), "りばあ");
    }

    #[test]
    fn keeps_standard_and_loose_yoon_variants() {
        let variants = japanese_lookup_variants("じゅー");
        assert_eq!(variants.first().map(String::as_str), Some("じゅー"));
        assert!(variants.iter().any(|value| value == "じゅう"));
        assert!(variants.iter().any(|value| value == "じゆう"));
    }

    #[test]
    fn preserves_literal_katakana_before_normalized_variants() {
        let variants = japanese_lookup_variants("リバーシ");
        assert_eq!(variants.first().map(String::as_str), Some("リバーシ"));
        assert!(variants.iter().any(|value| value == "りばーし"));
    }
}
