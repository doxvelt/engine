use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub operation: String,
    pub simulation_id: Option<String>,
    pub resource_id: Option<String>,
    pub query: BTreeMap<String, String>,
    pub body: Map<String, Value>,
}

pub fn resolve(
    method: &str,
    target: &str,
    body: Map<String, Value>,
) -> Result<Operation, (u16, String)> {
    let (path, search) = target.split_once('?').unwrap_or((target, ""));
    if !path.starts_with('/') || path.starts_with("//") {
        return Err((400, "Expected a local request path.".into()));
    }
    let mut parts = Vec::new();
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        let bytes = segment.as_bytes();
        for (index, byte) in bytes.iter().enumerate() {
            if *byte == b'%'
                && (index + 2 >= bytes.len()
                    || !bytes[index + 1].is_ascii_hexdigit()
                    || !bytes[index + 2].is_ascii_hexdigit())
            {
                return Err((400, "Request path contains invalid encoding.".into()));
            }
        }
        let decoded = percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| (400, "Request path contains invalid encoding.".into()))?
            .into_owned();
        if decoded == "." || decoded == ".." {
            return Err((404, "Request path contains a forbidden dot segment.".into()));
        }
        parts.push(decoded);
    }
    let query: BTreeMap<String, String> = url::form_urlencoded::parse(search.as_bytes())
        .into_owned()
        .collect();
    if query.contains_key("ownerScope") || body.contains_key("ownerScope") {
        return Err((
            400,
            "ownerScope is derived by the local API and must not be supplied.".into(),
        ));
    }
    let p: Vec<&str> = parts.iter().map(String::as_str).collect();
    let operation = match (method, p.as_slice()) {
        ("GET", ["health"]) => "health".into(),
        ("GET", ["runtime"]) => "runtime".into(),
        ("GET", ["recovery-identity"]) => "recovery.identity".into(),
        ("POST", ["examples", "last-crossing", "play"]) => "example.play".into(),
        ("GET", ["source"]) => "source.list".into(),
        ("GET", ["source", "file"]) => "source.read".into(),
        ("POST", ["source", "file"]) => "source.write".into(),
        ("POST", ["source", action @ ("compile" | "init" | "delete")]) => {
            format!("source.{action}")
        }
        ("POST", ["packages", action @ ("import" | "export")]) => format!("package.{action}"),
        ("POST", ["simulations", "start"]) => "simulation.start".into(),
        ("GET", ["simulations"]) => "simulation.list".into(),
        ("GET", ["simulations", _, "stage"]) => "stage.read".into(),
        ("GET", ["simulations", _, "actors"]) => "actors.list".into(),
        ("GET", ["simulations", _, "navigation"]) => "navigation.read".into(),
        ("POST", ["simulations", _, "navigation"]) => "navigation.write".into(),
        ("POST", ["simulations", _, "scene-headings"]) => "scene.create".into(),
        (
            "POST",
            [
                "simulations",
                _,
                "memories",
                action @ ("revise" | "retract"),
            ],
        ) => format!("memory.{action}"),
        ("GET", ["simulations", _, "context", _]) => "context.read".into(),
        (
            "GET",
            [
                "simulations",
                _,
                kind @ ("transcript" | "audience" | "access" | "beliefs" | "memories" | "branches"),
            ],
        ) => format!("projection.{kind}"),
        ("POST", ["simulations", _, "turns"]) => "turn.perform".into(),
        ("GET", ["simulations", _, "alternatives"]) => "alternative.list".into(),
        ("POST", ["simulations", _, "alternatives"]) => "alternative.create".into(),
        ("POST", ["simulations", _, "alternatives", "origin"]) => "alternative.origin".into(),
        ("GET", ["simulations", _, "alternatives", _]) => "alternative.read".into(),
        (
            "POST",
            [
                "simulations",
                _,
                "alternatives",
                _,
                action @ ("retry" | "discard"),
            ],
        ) => format!("alternative.{action}"),
        ("POST", ["simulations", _, "turn-draft"]) => "draft.legacy".into(),
        ("POST", ["simulations", _, "drafts"]) => "draft.create".into(),
        ("GET", ["simulations", _, "drafts"]) => "draft.list".into(),
        ("GET", ["simulations", _, "drafts", _]) => "draft.read".into(),
        (
            "POST",
            [
                "simulations",
                _,
                "drafts",
                _,
                action @ ("retry" | "revise" | "accept" | "discard"),
            ],
        ) => format!("draft.{action}"),
        ("POST", ["simulations", _, "audience"]) => "audience.change".into(),
        ("POST", ["simulations", _, "access"]) => "access.change".into(),
        ("POST", ["simulations", _, "whispers"]) => "whisper.create".into(),
        ("GET", ["simulations", _, "whispers"]) => "whisper.list".into(),
        ("POST", ["simulations", _, "correct-turn-body"]) => "turn.correct".into(),
        ("POST", ["simulations", _, action @ ("edit" | "regenerate" | "fork")]) => {
            format!("branch.{action}")
        }
        ("GET", ["simulations", _, "episode-memory"]) => "episode-memory.read".into(),
        (
            "POST",
            [
                "simulations",
                _,
                "episode-memory",
                action @ ("date" | "memorize"),
            ],
        ) => format!("episode-memory.{action}"),
        (
            "POST",
            [
                "simulations",
                _,
                "episodes",
                action @ ("close" | "request-closure"),
            ],
        ) => format!("episode.{action}"),
        ("GET", ["simulations", _, "memory-jobs", _, "transitions"]) => {
            "memory-job.transitions".into()
        }
        ("GET", ["simulations", _, "memory-jobs"]) => "memory-job.list".into(),
        ("POST", ["simulations", _, "memory-jobs", _]) => "memory-job.run".into(),
        _ => return Err((404, format!("No route for {method} {path}."))),
    };
    Ok(Operation {
        operation,
        simulation_id: if parts.first().is_some_and(|p| p == "simulations") && parts.len() >= 3 {
            Some(parts[1].clone())
        } else {
            None
        },
        resource_id: parts.get(3).cloned(),
        query,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_capture_identities_without_interpreting_actor_content() {
        let op = resolve(
            "POST",
            "/simulations/story%20one/drafts/draft-1/accept?branchId=main",
            Map::new(),
        )
        .unwrap();
        assert_eq!(op.operation, "draft.accept");
        assert_eq!(op.simulation_id.as_deref(), Some("story one"));
        assert_eq!(op.resource_id.as_deref(), Some("draft-1"));
        assert_eq!(op.query.get("branchId").unwrap(), "main");
    }
    #[test]
    fn malformed_and_extra_paths_cannot_reach_the_engine() {
        for path in [
            "/source/%GG",
            "/source/%ff",
            "/source/%2e%2e",
            "/simulations/x/turns/extra",
            "https://example.com/health",
        ] {
            assert!(resolve("POST", path, Map::new()).is_err(), "{path}");
        }
        assert!(resolve("GET", "/health?ownerScope=other", Map::new()).is_err());
        assert!(resolve("GET", "/simulations/x/episode-memory/extra", Map::new()).is_err());
    }
}
