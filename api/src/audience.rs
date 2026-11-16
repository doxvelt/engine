use crate::error::{EngineError, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AudienceSyntax {
    #[serde(rename = "scoped-v1")]
    Scoped,
    #[serde(rename = "scoped-fallback-v1")]
    Fallback,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub id: String,
    pub name: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PerformanceSpan {
    pub audience: Option<Vec<String>>,
    pub primary: String,
    pub fallback: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActorProjection {
    pub actor_id: String,
    pub text: String,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopedPerformance {
    pub version: u8,
    pub syntax: AudienceSyntax,
    pub base_audience: Option<Vec<String>>,
    pub spans: Vec<PerformanceSpan>,
    pub projections: Vec<ActorProjection>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ParsedPerformance {
    pub actor_id: String,
    pub audience: Vec<String>,
    pub performance: ScopedPerformance,
}
static SELECTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^#([\p{L}\p{N}_-]+(?:,[\p{L}\p{N}_-]+)*)").unwrap());
static ACTOR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^@([\p{L}\p{N}_-]+)(?:\s|$)").unwrap());

fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut result = Vec::new();
    for value in values {
        if !result.contains(&value) {
            result.push(value);
        }
    }
    result
}
fn resolve(label: &str, identities: &[Identity]) -> Result<String> {
    let matches: Vec<_> = identities
        .iter()
        .filter(|actor| actor.id == label || actor.name == label)
        .collect();
    if matches.len() != 1 {
        return Err(EngineError::invalid(format!(
            "Unresolved or ambiguous identity: {label}"
        )));
    }
    Ok(matches[0].id.clone())
}
fn recipients(labels: &str, identities: &[Identity]) -> Result<Vec<String>> {
    Ok(unique(
        labels
            .split(',')
            .map(|label| resolve(label, identities))
            .collect::<Result<Vec<_>>>()?,
    ))
}
fn next(text: &str, position: usize) -> Option<char> {
    text[position..].chars().next()
}
fn skip_space(text: &str, position: &mut usize) {
    while let Some(character) = next(text, *position) {
        if !character.is_whitespace() {
            break;
        }
        *position += character.len_utf8();
    }
}
fn escaped(text: &str, position: usize) -> Option<char> {
    if next(text, position) != Some('\\') {
        return None;
    }
    next(text, position + 1).filter(|character| "\\()|#@".contains(*character))
}
fn flush(
    spans: &mut Vec<PerformanceSpan>,
    unscoped: &mut String,
    base: &Option<Vec<String>>,
) -> Result<()> {
    if unscoped.is_empty() {
        return Ok(());
    }
    if base.is_none() && !unscoped.trim().is_empty() {
        return Err(EngineError::invalid(
            "Choose a default or turn audience for unscoped text.",
        ));
    }
    spans.push(PerformanceSpan {
        audience: base.clone(),
        primary: std::mem::take(unscoped),
        fallback: None,
    });
    Ok(())
}

/// Resolve flat audience scopes against pinned identities, without presence/access inference.
pub fn parse_performance(
    text: &str,
    actor_id: &str,
    audience: Option<&[String]>,
    identities: &[Identity],
    syntax: AudienceSyntax,
) -> Result<ParsedPerformance> {
    let text = text.trim();
    let mut position = 0;
    let mut actor_id = actor_id.to_owned();
    if text.starts_with('@') {
        let acting = ACTOR
            .captures(text)
            .ok_or_else(|| EngineError::invalid("Malformed actor selector."))?;
        actor_id = resolve(&acting[1], identities)?;
        position = acting.get(0).unwrap().end();
        skip_space(text, &mut position);
    }
    if !identities.iter().any(|actor| actor.id == actor_id) {
        return Err(EngineError::invalid("Choose a valid actor."));
    }
    let mut base = audience.map(|ids| unique(ids.iter().cloned()));
    for id in base.iter().flatten() {
        if !identities.iter().any(|actor| &actor.id == id) {
            return Err(EngineError::invalid(format!(
                "Unresolved audience identity: {id}"
            )));
        }
    }
    if let Some(leading) = SELECTOR.captures(&text[position..]) {
        let end = position + leading.get(0).unwrap().end();
        if next(text, end) != Some('(') {
            if next(text, end).is_some_and(|character| !character.is_whitespace()) {
                return Err(EngineError::invalid("Malformed turn audience."));
            }
            base = Some(recipients(&leading[1], identities)?);
            position = end;
            skip_space(text, &mut position);
        }
    }
    let mut spans = Vec::new();
    let mut unscoped = String::new();
    while position < text.len() {
        if let Some(character) = escaped(text, position) {
            unscoped.push(character);
            position += 1 + character.len_utf8();
            continue;
        }
        let character = next(text, position).unwrap();
        if character != '#' {
            unscoped.push(character);
            position += character.len_utf8();
            continue;
        }
        let scope = SELECTOR
            .captures(&text[position..])
            .filter(|scope| next(text, position + scope.get(0).unwrap().end()) == Some('('))
            .ok_or_else(|| {
                EngineError::invalid("Malformed audience scope; escape a literal # as \\#.")
            })?;
        flush(&mut spans, &mut unscoped, &base)?;
        let audience = recipients(&scope[1], identities)?;
        position += scope.get(0).unwrap().end() + 1;
        let mut depth = 1;
        let mut primary = String::new();
        let mut fallback: Option<String> = None;
        while position < text.len() && depth > 0 {
            if let Some(character) = escaped(text, position) {
                fallback.as_mut().unwrap_or(&mut primary).push(character);
                position += 1 + character.len_utf8();
                continue;
            }
            let character = next(text, position).unwrap();
            position += character.len_utf8();
            if character == '#' {
                return Err(EngineError::invalid(
                    "Nested audience scopes are unsupported; escape a literal #.",
                ));
            }
            if character == '(' {
                depth += 1;
            }
            if character == ')' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            if character == '|' && depth == 1 {
                if syntax != AudienceSyntax::Fallback {
                    return Err(EngineError::invalid(
                        "Observer fallbacks require explicit opt-in.",
                    ));
                }
                if fallback.is_some() {
                    return Err(EngineError::invalid(
                        "A scope may have only one fallback separator.",
                    ));
                }
                if base.is_none() {
                    return Err(EngineError::invalid(
                        "Observer fallback requires a resolved base audience.",
                    ));
                }
                fallback = Some(String::new());
                continue;
            }
            fallback.as_mut().unwrap_or(&mut primary).push(character);
        }
        if depth != 0 {
            return Err(EngineError::invalid("Unclosed audience scope."));
        }
        if fallback.is_some() && primary.trim().is_empty() {
            return Err(EngineError::invalid(
                "An observer fallback requires a nonempty primary performance.",
            ));
        }
        spans.push(PerformanceSpan {
            audience: Some(audience),
            primary,
            fallback,
        });
    }
    flush(&mut spans, &mut unscoped, &base)?;
    let mut projected = vec![(actor_id.clone(), String::new())];
    let append = |projected: &mut Vec<(String, String)>, id: &str, text: &str| {
        if let Some((_, value)) = projected.iter_mut().find(|(actor, _)| actor == id) {
            value.push_str(text);
        } else {
            projected.push((id.to_owned(), text.to_owned()));
        }
    };
    for span in &spans {
        for id in
            unique(std::iter::once(actor_id.clone()).chain(span.audience.iter().flatten().cloned()))
        {
            append(&mut projected, &id, &span.primary);
        }
        for id in base.iter().flatten() {
            if id != &actor_id && !span.audience.as_ref().is_some_and(|ids| ids.contains(id)) {
                if let Some(fallback) = &span.fallback {
                    append(&mut projected, id, fallback);
                }
            }
        }
    }
    let projections: Vec<_> = projected
        .into_iter()
        .filter_map(|(actor_id, text)| {
            let text = text.trim();
            if text.is_empty() {
                None
            } else {
                Some(ActorProjection {
                    actor_id,
                    text: text.to_owned(),
                })
            }
        })
        .collect();
    if projections.is_empty() {
        return Err(EngineError::invalid("Turn contains no performance."));
    }
    Ok(ParsedPerformance {
        actor_id,
        audience: projections.iter().map(|p| p.actor_id.clone()).collect(),
        performance: ScopedPerformance {
            version: 1,
            syntax,
            base_audience: base,
            spans,
            projections,
        },
    })
}

/// A model-safe record strips all scope structure, recipient unions and hidden text.
pub fn project_turn(turn: &Value, observer: &str) -> Option<Value> {
    let mut visible = turn.as_object()?.clone();
    if let Some(performance) = visible.remove("performance") {
        let projection = performance
            .get("projections")?
            .as_array()?
            .iter()
            .find(|p| p.get("actorId").and_then(Value::as_str) == Some(observer))?;
        visible.insert("text".into(), projection.get("text")?.clone());
        visible.insert("audience".into(), serde_json::json!([observer]));
    } else if !visible
        .get("audience")?
        .as_array()?
        .iter()
        .any(|id| id.as_str() == Some(observer))
    {
        return None;
    }
    Some(Value::Object(visible))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cast() -> Vec<Identity> {
        ["Corin", "Mara", "Nell"]
            .map(|name| Identity {
                id: name.to_lowercase(),
                name: name.into(),
            })
            .to_vec()
    }
    fn base() -> Vec<String> {
        vec!["mara".into(), "nell".into()]
    }
    #[test]
    fn scoped_private_content_never_reaches_excluded_observers() {
        let parsed = parse_performance(
            "#Mara(secret)",
            "corin",
            Some(&base()),
            &cast(),
            AudienceSyntax::Scoped,
        )
        .unwrap();
        assert_eq!(parsed.audience, ["corin", "mara"]);
        let turn = serde_json::json!({"actorId":"corin","text":"#Mara(secret)","audience":parsed.audience,"performance":parsed.performance});
        assert!(project_turn(&turn, "nell").is_none());
        let visible = project_turn(&turn, "mara").unwrap();
        assert_eq!(visible["text"], "secret");
        assert_eq!(visible["audience"], serde_json::json!(["mara"]));
        assert!(visible.get("performance").is_none());
    }
    #[test]
    fn fallbacks_are_opted_in_and_do_not_duplicate_the_actors_perception() {
        let text = "He whispers: #Mara(The key is here.|[unintelligible]) Then steps back.";
        assert!(
            parse_performance(
                text,
                "corin",
                Some(&base()),
                &cast(),
                AudienceSyntax::Scoped
            )
            .is_err()
        );
        let parsed = parse_performance(
            text,
            "corin",
            Some(&base()),
            &cast(),
            AudienceSyntax::Fallback,
        )
        .unwrap();
        assert_eq!(
            parsed
                .performance
                .projections
                .iter()
                .find(|p| p.actor_id == "nell")
                .unwrap()
                .text,
            "He whispers: [unintelligible] Then steps back."
        );
        assert_eq!(
            parsed
                .performance
                .projections
                .iter()
                .find(|p| p.actor_id == "corin")
                .unwrap()
                .text,
            "He whispers: The key is here. Then steps back."
        );
    }
    #[test]
    fn unresolved_bases_stay_unresolved_and_plain_names_do_not_route() {
        assert!(
            parse_performance("Hello Mara", "corin", None, &cast(), AudienceSyntax::Scoped)
                .is_err()
        );
        let parsed = parse_performance(
            "#Mara(secret)",
            "corin",
            None,
            &cast(),
            AudienceSyntax::Scoped,
        )
        .unwrap();
        assert_eq!(parsed.performance.base_audience, None);
        assert!(
            parse_performance(
                "#Mara(secret) public",
                "corin",
                None,
                &cast(),
                AudienceSyntax::Scoped
            )
            .is_err()
        );
        assert!(
            parse_performance(
                "#Mara(secret|fallback)",
                "corin",
                None,
                &cast(),
                AudienceSyntax::Fallback
            )
            .is_err()
        );
    }
    #[test]
    fn malformed_scopes_and_ambiguous_identities_fail_without_widening_delivery() {
        for text in [
            "#Unknown(secret)",
            "#Mara(secret",
            "#Mara(#Nell(secret))",
            "#Mara(|fallback)",
            "#Mara(a|b|c)",
            "#Mara! hi",
        ] {
            assert!(
                parse_performance(
                    text,
                    "corin",
                    Some(&base()),
                    &cast(),
                    AudienceSyntax::Fallback
                )
                .is_err(),
                "{text}"
            );
        }
        let mut identities = cast();
        identities.push(Identity {
            id: "other".into(),
            name: "Mara".into(),
        });
        assert!(
            parse_performance(
                "#Mara(secret)",
                "corin",
                Some(&base()),
                &identities,
                AudienceSyntax::Scoped
            )
            .is_err()
        );
    }
    #[test]
    fn unicode_actor_override_escaping_and_whitespace_are_preserved() {
        let mut identities = cast();
        identities.push(Identity {
            id: "éva".into(),
            name: "Éva".into(),
        });
        let parsed = parse_performance(
            "@Éva #Mara Hello #Nell(secret )world \\#tag",
            "corin",
            Some(&base()),
            &identities,
            AudienceSyntax::Scoped,
        )
        .unwrap();
        assert_eq!(parsed.actor_id, "éva");
        assert_eq!(parsed.performance.base_audience, Some(vec!["mara".into()]));
        assert_eq!(
            parsed
                .performance
                .projections
                .iter()
                .find(|p| p.actor_id == "mara")
                .unwrap()
                .text,
            "Hello world #tag"
        );
        assert_eq!(
            parsed
                .performance
                .projections
                .iter()
                .find(|p| p.actor_id == "nell")
                .unwrap()
                .text,
            "secret"
        );
    }
}
