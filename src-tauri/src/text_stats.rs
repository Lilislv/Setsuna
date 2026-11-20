//! Word and sentence counts for reading statistics.
//!
//! Japanese words come from the same Lindera + Ve grouping the lookup uses, so
//! `来た` or `引き返す` count as one word and punctuation never counts. Other
//! scripts are split on whitespace.

use crate::japanese_tokenizer::segment_text;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct LineStats {
    pub words: u32,
    pub sentences: u32,
}

fn is_japanese_char(c: char) -> bool {
    matches!(c,
        '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}'
        | '\u{f900}'..='\u{faff}' | '\u{ff66}'..='\u{ff9f}' | '\u{3005}' | '\u{20000}'..='\u{323af}')
}

fn has_word_char(text: &str) -> bool {
    text.chars().any(char::is_alphanumeric)
}

fn is_terminator(chars: &[char], index: usize) -> bool {
    match chars[index] {
        '。' | '．' | '！' | '？' | '!' | '?' | '｡' => true,
        // A Latin full stop ends a sentence only before whitespace/closing marks
        // or at the end, so "3.5" and "e.g" stay intact.
        '.' => chars
            .get(index + 1)
            .map_or(true, |next| next.is_whitespace() || is_closing(*next) || *next == '.'),
        _ => false,
    }
}

fn is_closing(c: char) -> bool {
    matches!(c, '」' | '』' | '）' | ')' | '】' | '〉' | '》' | '"' | '\'' | '”' | '’' | '］' | ']')
}

/// Word spans as (start, end) char offsets.
fn word_spans(text: &str) -> Vec<(usize, usize)> {
    if text.chars().any(is_japanese_char) {
        if let Ok(tokens) = segment_text(text) {
            return tokens
                .into_iter()
                .filter(|token| has_word_char(&token.text))
                .map(|token| (token.start, token.end))
                .collect();
        }
    }
    let mut spans = Vec::new();
    let mut start = None;
    for (index, c) in text.chars().enumerate() {
        if c.is_whitespace() {
            if let Some(begin) = start.take() {
                spans.push((begin, index));
            }
        } else if start.is_none() {
            start = Some(index);
        }
    }
    if let Some(begin) = start {
        spans.push((begin, text.chars().count()));
    }
    let chars: Vec<char> = text.chars().collect();
    spans.retain(|&(begin, end)| chars[begin..end].iter().any(|c| c.is_alphanumeric()));
    spans
}

/// Counts words and sentences in one hooked line.
///
/// A sentence is a stretch ending in 。！？ (or . ! ?) that contains a word. A
/// trailing stretch without a terminator counts only when it holds at least two
/// words, so speaker-name lines (`豹馬`) and fragments like `けれど、` are not
/// counted, while unterminated dialogue such as `（君は本当に、そこにいるんだな）` is.
pub fn count_line(text: &str) -> LineStats {
    let text = text.trim();
    if text.is_empty() {
        return LineStats::default();
    }
    let words = word_spans(text);
    let chars: Vec<char> = text.chars().collect();
    let words_in = |from: usize, to: usize| words.iter().filter(|&&(start, _)| start >= from && start < to).count();

    let mut sentences = 0;
    let mut fragment_start = 0;
    let mut index = 0;
    while index < chars.len() {
        if is_terminator(&chars, index) {
            let mut end = index + 1;
            while end < chars.len() && (is_terminator(&chars, end) || is_closing(chars[end])) {
                end += 1;
            }
            if words_in(fragment_start, end) > 0 {
                sentences += 1;
            }
            fragment_start = end;
            index = end;
            continue;
        }
        index += 1;
    }
    if fragment_start < chars.len() && words_in(fragment_start, chars.len()) >= 2 {
        sentences += 1;
    }

    LineStats { words: words.len() as u32, sentences }
}

#[tauri::command]
pub async fn count_text_stats(lines: Vec<String>) -> Result<Vec<LineStats>, String> {
    tauri::async_runtime::spawn_blocking(move || lines.iter().map(|line| count_line(line)).collect())
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_japanese_words_without_punctuation() {
        let stats = count_line("米屋で米をもらい、来た道を引き返す。");
        assert_eq!(stats.sentences, 1);
        // 米屋 で 米 を もらい 来た 道 を 引き返す
        assert!((8..=10).contains(&stats.words), "words = {}", stats.words);
    }

    #[test]
    fn counts_sentences_in_vn_lines() {
        assert_eq!(count_line("「……ん。ちゃんと、いる」").sentences, 2);
        assert_eq!(count_line("（君は本当に、そこにいるんだな）").sentences, 1);
        assert_eq!(count_line("誰にも見てもらえない。 光が当たらない、真っ暗な場所だ。").sentences, 2);
        assert_eq!(count_line("「えっ！？　本当？」").sentences, 2);
    }

    #[test]
    fn speaker_names_and_fragments_are_not_sentences() {
        assert_eq!(count_line("豹馬").sentences, 0);
        assert_eq!(count_line("豹馬").words, 1);
        assert_eq!(count_line("けれど、").sentences, 0);
        assert_eq!(count_line("……").words, 0);
        assert_eq!(count_line("……").sentences, 0);
    }

    #[test]
    fn counts_latin_and_cyrillic_by_whitespace() {
        let stats = count_line("He paid 3.5 dollars. Then he left!");
        assert_eq!(stats.words, 7);
        assert_eq!(stats.sentences, 2);
        let stats = count_line("Привет, как дела? Всё хорошо.");
        assert_eq!(stats.words, 5);
        assert_eq!(stats.sentences, 2);
    }
}
