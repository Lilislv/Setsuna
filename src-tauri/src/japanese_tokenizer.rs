// Japanese word grouping is a Rust adaptation of the MIT-licensed Ve parser:
// Copyright (c) 2021 Leo Rafael Orpilla.
// https://github.com/arianneorpilla/ve_dart

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use serde::Serialize;
use std::borrow::Cow;
use std::sync::OnceLock;

const NO_DATA: &str = "*";
const POS1: usize = 0;
const POS2: usize = 1;
const POS3: usize = 2;
const CTYPE: usize = 4;
const CFORM: usize = 5;
const BASIC: usize = 6;
const READING: usize = 7;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TextToken {
    pub text: String,
    pub reading: Option<String>,
    pub lemma: Option<String>,
    pub start: usize,
    pub end: usize,
    pub part_of_speech: String,
    pub lookup: bool,
}

#[derive(Clone, Debug)]
struct Morpheme {
    surface: String,
    features: Vec<String>,
    start: usize,
    end: usize,
}

impl Morpheme {
    fn feature(&self, index: usize) -> &str {
        self.features.get(index).map(String::as_str).unwrap_or(NO_DATA)
    }
}

#[derive(Clone, Debug)]
struct WordBuilder {
    text: String,
    reading: String,
    lemma: String,
    start: usize,
    end: usize,
    part_of_speech: String,
}

impl WordBuilder {
    fn from_morpheme(morpheme: &Morpheme, part_of_speech: &str) -> Self {
        Self {
            text: morpheme.surface.clone(),
            reading: clean_feature(morpheme.feature(READING)),
            lemma: clean_feature(morpheme.feature(BASIC)),
            start: morpheme.start,
            end: morpheme.end,
            part_of_speech: part_of_speech.to_string(),
        }
    }

    fn append(&mut self, morpheme: &Morpheme, append_lemma: bool) {
        self.text.push_str(&morpheme.surface);
        self.reading.push_str(&clean_feature(morpheme.feature(READING)));
        if append_lemma {
            self.lemma.push_str(&clean_feature(morpheme.feature(BASIC)));
        }
        self.end = morpheme.end;
    }

    fn finish(self) -> TextToken {
        let reading = optional_reading(&self.text, &self.reading);
        let lemma = optional_feature(&self.lemma);
        TextToken {
            lookup: contains_lookup_character(&self.text),
            text: self.text,
            reading,
            lemma,
            start: self.start,
            end: self.end,
            part_of_speech: self.part_of_speech,
        }
    }
}

fn segmenter() -> Result<&'static Segmenter, String> {
    static SEGMENTER: OnceLock<Result<Segmenter, String>> = OnceLock::new();
    SEGMENTER
        .get_or_init(|| {
            let dictionary = load_dictionary("embedded://ipadic")
                .map_err(|error| format!("Failed to load embedded IPADIC: {error}"))?;
            Ok(Segmenter::new(Mode::Normal, dictionary, None))
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn segment_text(text: &str) -> Result<Vec<TextToken>, String> {
    if text.is_empty() {
        return Ok(Vec::new());
    }

    let mut raw_tokens = segmenter()?
        .segment(Cow::Borrowed(text))
        .map_err(|error| format!("Japanese segmentation failed: {error}"))?;

    let mut morphemes = Vec::with_capacity(raw_tokens.len());
    let mut covered_byte = 0usize;
    for token in raw_tokens.iter_mut() {
        let surface = token.surface.as_ref().to_string();
        if surface.is_empty() {
            continue;
        }
        if token.byte_start > covered_byte {
            push_plain_gap(text, covered_byte, token.byte_start, &mut morphemes);
        }
        let mut features: Vec<String> = token.details().into_iter().map(str::to_string).collect();
        features.resize(9, NO_DATA.to_string());
        let start = text[..token.byte_start].chars().count();
        let end = start + surface.chars().count();
        morphemes.push(Morpheme {
            surface,
            features,
            start,
            end,
        });
        covered_byte = covered_byte.max(token.byte_end);
    }
    if covered_byte < text.len() {
        push_plain_gap(text, covered_byte, text.len(), &mut morphemes);
    }

    let words = group_ve_words(&morphemes);
    Ok(words
        .into_iter()
        .flat_map(split_non_japanese_token)
        .collect())
}

fn push_plain_gap(text: &str, byte_start: usize, byte_end: usize, output: &mut Vec<Morpheme>) {
    if byte_start >= byte_end {
        return;
    }
    let surface = text[byte_start..byte_end].to_string();
    let start = text[..byte_start].chars().count();
    let end = start + surface.chars().count();
    let mut features = vec!["記号".to_string(), "空白".to_string()];
    features.resize(9, NO_DATA.to_string());
    output.push(Morpheme {
        surface,
        features,
        start,
        end,
    });
}

fn group_ve_words(tokens: &[Morpheme]) -> Vec<TextToken> {
    let mut words: Vec<WordBuilder> = Vec::new();
    let mut index = 0usize;

    while index < tokens.len() {
        let current = &tokens[index];
        let previous = index.checked_sub(1).and_then(|value| tokens.get(value));
        let following = tokens.get(index + 1);
        let pos1 = current.feature(POS1);
        let pos2 = current.feature(POS2);
        let pos3 = current.feature(POS3);

        let mut part_of_speech = pos1.to_string();
        let mut attach_to_previous = false;
        let mut append_lemma = false;
        let mut eat_next = false;
        let mut eat_next_lemma = true;

        match pos1 {
            "名詞" => match pos2 {
                "固有名詞" => part_of_speech = "固有名詞".to_string(),
                "代名詞" => part_of_speech = "代名詞".to_string(),
                "数" => {
                    part_of_speech = "数".to_string();
                    if words.last().is_some_and(|word| word.part_of_speech == "数") {
                        attach_to_previous = true;
                        append_lemma = true;
                    }
                }
                "接尾" => {
                    if pos3 != "人名" {
                        attach_to_previous = true;
                        append_lemma = true;
                    }
                }
                "副詞可能" | "サ変接続" | "形容動詞語幹" | "ナイ形容詞語幹" => {
                    if let Some(next) = following {
                        match next.feature(CTYPE) {
                            "サ変・スル" => {
                                part_of_speech = "動詞".to_string();
                                eat_next = true;
                            }
                            "特殊・ダ" if next.feature(POS2) == "体言接続" => {
                                part_of_speech = "形容詞".to_string();
                                eat_next = true;
                                eat_next_lemma = false;
                            }
                            "特殊・ナイ" => {
                                part_of_speech = "形容詞".to_string();
                                eat_next = true;
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            },
            "助動詞" => {
                part_of_speech = "助動詞".to_string();
                let qualifying = matches!(
                    current.feature(CTYPE),
                    "特殊・タ" | "特殊・ナイ" | "特殊・タイ" | "特殊・マス" | "特殊・ヌ"
                );
                let previous_is_binding_particle = previous
                    .is_some_and(|token| token.feature(POS2) == "係助詞");
                if qualifying && !previous_is_binding_particle {
                    attach_to_previous = true;
                } else if current.feature(CTYPE) == "不変化型" && current.feature(BASIC) == "ん" {
                    attach_to_previous = true;
                } else if matches!(current.feature(CTYPE), "特殊・ダ" | "特殊・デス")
                    && current.surface != "な"
                {
                    part_of_speech = "動詞".to_string();
                }
            }
            "動詞" => {
                part_of_speech = "動詞".to_string();
                if pos2 == "接尾" || (pos2 == "非自立" && current.feature(CFORM) != "命令ｉ") {
                    attach_to_previous = true;
                }
            }
            "形容詞" => part_of_speech = "形容詞".to_string(),
            "助詞" => {
                part_of_speech = "助詞".to_string();
                if (pos2 == "接続助詞" && matches!(current.surface.as_str(), "て" | "で" | "ば"))
                    || current.surface == "に"
                {
                    attach_to_previous = true;
                }
            }
            "接頭詞" => part_of_speech = "接頭詞".to_string(),
            "連体詞" => part_of_speech = "連体詞".to_string(),
            "接続詞" => part_of_speech = "接続詞".to_string(),
            "副詞" => part_of_speech = "副詞".to_string(),
            "記号" => part_of_speech = "記号".to_string(),
            "フィラー" | "感動詞" => part_of_speech = "感動詞".to_string(),
            "その他" => part_of_speech = "その他".to_string(),
            _ => {}
        }

        if attach_to_previous && !words.is_empty() {
            if let Some(word) = words.last_mut() {
                word.append(current, append_lemma);
                if pos2 == "接尾" && pos3 == "特殊" && current.feature(BASIC) == "さ" {
                    word.part_of_speech = "名詞".to_string();
                }
            }
        } else {
            let mut word = WordBuilder::from_morpheme(current, &part_of_speech);
            if eat_next {
                if let Some(next) = following {
                    word.append(next, eat_next_lemma);
                    index += 1;
                }
            }
            words.push(word);
        }

        index += 1;
    }

    words.into_iter().map(WordBuilder::finish).collect()
}

fn split_non_japanese_token(token: TextToken) -> Vec<TextToken> {
    if token.text.chars().any(is_japanese_character) {
        return vec![token];
    }

    let chars: Vec<char> = token.text.chars().collect();
    if !chars.iter().any(|character| is_latin_word_character(*character)) {
        return vec![token];
    }

    let mut parts = Vec::new();
    let mut index = 0usize;
    while index < chars.len() {
        let start = index;
        let word = is_latin_word_character(chars[index]);
        index += 1;
        if word {
            while index < chars.len()
                && (is_latin_word_character(chars[index]) || is_latin_joiner(chars[index]))
            {
                index += 1;
            }
            while index > start && !is_latin_word_character(chars[index - 1]) {
                index -= 1;
            }
        } else {
            while index < chars.len() && !is_latin_word_character(chars[index]) {
                index += 1;
            }
        }

        if index <= start {
            index = start + 1;
        }
        let text: String = chars[start..index].iter().collect();
        parts.push(TextToken {
            lookup: word,
            text,
            reading: None,
            lemma: None,
            start: token.start + start,
            end: token.start + index,
            part_of_speech: if word { "latin" } else { "plain" }.to_string(),
        });
    }
    parts
}

fn clean_feature(value: &str) -> String {
    if value == NO_DATA || value == "UNK" {
        String::new()
    } else {
        value.to_string()
    }
}

fn optional_feature(value: &str) -> Option<String> {
    (!value.is_empty() && value != NO_DATA && value != "UNK").then(|| value.to_string())
}

fn optional_reading(surface: &str, reading: &str) -> Option<String> {
    let reading = katakana_to_hiragana(reading);
    (!reading.is_empty() && reading != surface).then_some(reading)
}

fn katakana_to_hiragana(value: &str) -> String {
    value
        .chars()
        .map(|character| match character {
            '\u{30a1}'..='\u{30f6}' => char::from_u32(character as u32 - 0x60).unwrap_or(character),
            _ => character,
        })
        .collect()
}

fn contains_lookup_character(value: &str) -> bool {
    value
        .chars()
        .any(|character| is_japanese_character(character) || is_latin_word_character(character))
}

fn is_japanese_character(character: char) -> bool {
    matches!(
        character,
        '\u{3040}'..='\u{30ff}'
            | '\u{3400}'..='\u{9fff}'
            | '\u{f900}'..='\u{faff}'
            | '\u{ff66}'..='\u{ff9f}'
            | '々'
            | '〆'
    )
}

fn is_latin_word_character(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(character, '\u{00c0}'..='\u{024f}' | '\u{1e00}'..='\u{1eff}')
}

fn is_latin_joiner(character: char) -> bool {
    matches!(character, '\'' | '\u{2019}' | '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn surfaces(text: &str) -> Vec<String> {
        segment_text(text)
            .expect("IPADIC segmentation must work")
            .into_iter()
            .map(|token| token.text)
            .collect()
    }

    #[test]
    fn groups_inflection_and_connective_particles_like_jidoujisho() {
        assert_eq!(
            surfaces("離さないって決めたから"),
            vec!["離さない", "って", "決めた", "から"]
        );
        assert_eq!(
            surfaces("そぞろに鼻を利かせては"),
            vec!["そぞろに", "鼻", "を", "利かせて", "は"]
        );
    }

    #[test]
    fn returns_stable_offsets_and_never_splits_every_kanji() {
        let text = "米屋で米をもらい、来た道を引き返す。";
        let tokens = segment_text(text).unwrap();
        assert_eq!(tokens.first().map(|token| token.text.as_str()), Some("米屋"));
        assert!(tokens.iter().any(|token| token.text == "来た"));
        assert!(tokens.iter().any(|token| token.text == "引き返す"));
        for token in tokens {
            let actual: String = text
                .chars()
                .skip(token.start)
                .take(token.end - token.start)
                .collect();
            assert_eq!(actual, token.text);
        }
    }

    #[test]
    fn keeps_latin_words_clickable_in_mixed_text() {
        let tokens = segment_text("Setsunaでlookupする").unwrap();
        assert!(tokens.iter().any(|token| token.text == "Setsuna" && token.lookup));
        assert!(tokens.iter().any(|token| token.text == "lookup" && token.lookup));
    }

    #[test]
    fn preserves_spaces_and_newlines_exactly() {
        let text = "私は Setsuna を使う。\n次の行";
        let tokens = segment_text(text).unwrap();
        assert_eq!(
            tokens.iter().map(|token| token.text.as_str()).collect::<String>(),
            text
        );
    }
}
