use icu_collator::{Collator, CollatorBorrowed};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{cmp::Ordering, sync::LazyLock};

static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
    Collator::try_new(Default::default(), Default::default()).expect("compiled collation data")
});

pub fn domain_id(kind: &str, parts: &[&str]) -> String {
    let digest = format!("{:x}", Sha256::digest(parts.join("\0").as_bytes()));
    format!("{kind}_{}", &digest[..32])
}
pub fn fingerprint(value: &Value) -> String {
    sha256(&stable_stringify(value))
}
pub fn sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn locale_compare(left: &str, right: &str) -> Ordering {
    COLLATOR.compare(left, right)
}
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|c|matches!(c,'\t'..='\r'|'\u{20}'|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn index_key(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|number| *number != u32::MAX && number.to_string() == key)
}
fn key_order(left: &str, right: &str) -> Ordering {
    match (index_key(left), index_key(right)) {
        (Some(a), Some(b)) => a.cmp(&b),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => COLLATOR.compare(left, right),
    }
}
/// Preserve the existing command/archive fingerprint contract, including JS
/// object-index ordering, locale collation and ECMAScript number rendering.
pub fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(items) => format!(
            "[{}]",
            items
                .iter()
                .map(stable_stringify)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(object) => {
            let mut entries: Vec<_> = object.iter().collect();
            entries.sort_by(|(left, _), (right, _)| key_order(left, right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        stable_stringify(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Number(number) => {
            if let Some(integer) = number.as_i64() {
                integer.to_string()
            } else if let Some(integer) = number.as_u64() {
                integer.to_string()
            } else {
                ryu_js::Buffer::new()
                    .format_finite(number.as_f64().expect("finite JSON number"))
                    .to_owned()
            }
        }
        _ => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_input_is_independent_of_insertion_order_and_retains_js_numbers() {
        let input: Value = serde_json::from_str(
            r#"{"z":1.0,"A":1e-7,"a":-0.0,"2":2,"10":10,"api_key":true,"apiKey":false}"#,
        )
        .unwrap();
        assert_eq!(
            stable_stringify(&input),
            r#"{"2":2,"10":10,"a":0,"A":1e-7,"api_key":true,"apiKey":false,"z":1}"#
        );
        assert_eq!(
            domain_id("commit", &["local", "sim", "start"]),
            "commit_4beacf49e8c044f5f7cf66d008b8a01b"
        );
    }
}
