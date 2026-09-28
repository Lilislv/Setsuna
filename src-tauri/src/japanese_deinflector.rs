// Japanese grammar adapted from Yomitan's LanguageTransformer.
// Copyright (C) 2024-2026 Yomitan Authors; GPL-3.0-or-later.
// See licenses/Yomitan-GPL-3.0.txt and THIRD_PARTY_NOTICES.md.
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Deserialize)]
pub(crate) struct Rule {
    pub id: String,
    pub name: String,
    pub description: String,
    pub input: String,
    pub output: String,
    whole: bool,
    conditions_in: u32,
    conditions_out: u32,
}

#[derive(Deserialize)]
struct Grammar {
    pos: HashMap<String, u32>,
    rules: Vec<Rule>,
    #[serde(skip)]
    endings: HashMap<char, Vec<usize>>,
}

fn grammar() -> &'static Grammar {
    static GRAMMAR: OnceLock<Grammar> = OnceLock::new();
    GRAMMAR.get_or_init(|| {
        let mut grammar: Grammar = serde_json::from_str(include_str!("yomitan-japanese.json"))
            .expect("checked-in Yomitan grammar must be valid");
        for (index, rule) in grammar.rules.iter().enumerate() {
            if let Some(last) = rule.input.chars().last() {
                grammar.endings.entry(last).or_default().push(index);
            }
        }
        grammar
    })
}

#[derive(Clone, Debug)]
pub(crate) struct Form {
    pub text: String,
    pub conditions: u32,
    // Dictionary-form reason first, source-form reason last, as in Yomitan.
    pub trace: Vec<usize>,
    previous: Vec<(usize, String)>,
}

pub(crate) fn rule(index: usize) -> &'static Rule {
    &grammar().rules[index]
}

pub(crate) fn conditions_match(current: u32, next: u32) -> bool {
    current == 0 || current & next != 0
}

/// Keep grammatical state throughout every step. In particular a -た result
/// cannot be fed to an arbitrary suffix rule just because its spelling matches.
pub(crate) fn transform(source: &str) -> Vec<Form> {
    let grammar = grammar();
    let mut results = vec![Form {
        text: source.to_string(), conditions: 0, trace: Vec::new(), previous: Vec::new(),
    }];
    let mut seen = HashSet::new();
    let mut index = 0;
    while index < results.len() {
        let form = results[index].clone();
        index += 1;
        let Some(indices) = form.text.chars().last().and_then(|last| grammar.endings.get(&last)) else { continue };
        for &rule_index in indices {
            let rule = &grammar.rules[rule_index];
            if !conditions_match(form.conditions, rule.conditions_in)
                || !form.text.ends_with(&rule.input)
                || (rule.whole && form.text != rule.input)
                || form.previous.iter().any(|(i, text)| *i == rule_index && text == &form.text)
            { continue; }
            let text = format!("{}{}", &form.text[..form.text.len() - rule.input.len()], rule.output);
            if text.is_empty() { continue; }
            let mut trace = form.trace.clone();
            trace.insert(0, rule_index);
            let key = (text.clone(), rule.conditions_out, trace.iter().map(|i| &grammar.rules[*i].id).collect::<Vec<_>>());
            if !seen.insert(key) { continue; }
            let mut previous = form.previous.clone();
            previous.push((rule_index, form.text.clone()));
            results.push(Form { text, conditions: rule.conditions_out, trace, previous });
        }
    }
    results
}

pub(crate) fn is_dictionary_form(conditions: u32) -> bool {
    conditions == 0 || grammar().pos.values().any(|flags| conditions & flags != 0)
}

/// Older Setsuna imports combined display tags and discarded the dedicated
/// Yomitan rules field. Accept precise JMdict POS aliases for those databases.
pub(crate) fn tags_match(conditions: u32, tags: &str) -> bool {
    if conditions == 0 { return true; }
    let mut flags = 0;
    for tag in tags.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '|' | '[' | ']' | '"')) {
        let pos = if tag.starts_with("v5") { "v5" }
            else if tag.starts_with("v1") { "v1" }
            else if tag.starts_with("vs") { "vs" }
            else if tag == "adj-ix" { "adj-i" }
            else { tag };
        flags |= grammar().pos.get(pos).copied().unwrap_or(0);
    }
    // Dictionaries without POS metadata remain usable; tagged nouns do not
    // become verbs. New imports retain their dedicated rules explicitly.
    if flags == 0 && tags.trim().is_empty() { return true; }
    conditions_match(conditions, flags)
}

pub(crate) fn entry_matches(conditions: u32, rules: Option<&str>, legacy_tags: &str) -> bool {
    match rules {
        Some(rules) => conditions_match(conditions, rules.split_whitespace()
            .fold(0, |flags, pos| flags | grammar().pos.get(pos).copied().unwrap_or(0))),
        None => tags_match(conditions, legacy_tags),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Deserialize)]
    struct Case { term: String, source: String, conditions: Option<u32>, reasons: Option<Vec<String>>, valid: bool }

    #[test]
    fn matches_upstream_yomitan_japanese_cases() {
        let cases: Vec<Case> = serde_json::from_str(include_str!("../../tests/yomitan-japanese-parity.json")).unwrap();
        for case in &cases {
            let found = transform(&case.source).iter().any(|form| {
                form.text == case.term
                    && case.conditions.map_or(true, |flags| conditions_match(form.conditions, flags))
                    && case.reasons.as_ref().map_or(true, |reasons| {
                        form.trace.iter().map(|i| &rule(*i).id).eq(reasons.iter())
                    })
            });
            assert_eq!(found, case.valid, "{} -> {} {:?}", case.source, case.term, case.reasons);
        }
        assert!(cases.len() > 1400);
    }

    #[test]
    fn distinguishes_verb_classes_and_rejects_nouns() {
        let forms = transform("食べた");
        let eat = forms.iter().find(|form| form.text == "食べる").unwrap();
        assert!(tags_match(eat.conditions, "v1 vt"));
        assert!(!tags_match(eat.conditions, "n"));
        assert!(!tags_match(eat.conditions, "v5r"));
    }
}
