use crate::{
    content::{AccessLink, SourceSpan},
    error::{EngineError, Result},
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessAction {
    Grant,
    Revoke,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessChange {
    pub action: AccessAction,
    pub member: String,
    pub container: String,
    pub reason: Option<String>,
}
pub fn assert_valid_graph(links: &[AccessLink]) -> Result<()> {
    fn visit(links: &[AccessLink], id: &str, path: &mut Vec<String>) -> Result<()> {
        if path.iter().any(|previous| previous == id) {
            let mut cycle = path.clone();
            cycle.push(id.into());
            return Err(EngineError::invalid(format!(
                "Membership access cycle: {}",
                cycle.join(" -> ")
            )));
        }
        path.push(id.into());
        for link in links.iter().filter(|link| link.member == id) {
            visit(links, &link.container, path)?;
        }
        path.pop();
        Ok(())
    }
    for link in links {
        visit(links, &link.member, &mut vec![])?;
    }
    Ok(())
}
pub fn apply_change(links: &[AccessLink], change: &AccessChange) -> Vec<AccessLink> {
    // Match the reference Map: keep first-key order and the last edge's provenance.
    let mut next: Vec<AccessLink> = Vec::new();
    let mut positions = std::collections::HashMap::<_, usize>::new();
    for link in links {
        let key = (&link.member, &link.container, &link.mode);
        if let Some(index) = positions.get(&key) {
            next[*index] = link.clone();
        } else {
            positions.insert(key, next.len());
            next.push(link.clone());
        }
    }
    let position = next.iter().position(|link| {
        link.member == change.member && link.container == change.container && link.mode == "member"
    });
    if change.action == AccessAction::Revoke {
        if let Some(index) = position {
            next.remove(index);
        }
    } else {
        let link = AccessLink {
            member: change.member.clone(),
            container: change.container.clone(),
            mode: "member".into(),
            source_span: SourceSpan {
                file: "runtime".into(),
                line: 0,
                quote: change
                    .reason
                    .clone()
                    .filter(|r| !r.is_empty())
                    .unwrap_or_else(|| {
                        format!("grant {} access to {}", change.member, change.container)
                    }),
            },
        };
        if let Some(index) = position {
            next[index] = link;
        } else {
            next.push(link);
        }
    }
    next
}
pub fn apply_validated_change(
    links: &[AccessLink],
    change: &AccessChange,
) -> Result<Vec<AccessLink>> {
    let next = apply_change(links, change);
    assert_valid_graph(&next)?;
    Ok(next)
}
pub fn resolve_paths(start: &str, links: &[AccessLink]) -> BTreeMap<String, Vec<String>> {
    let mut paths = BTreeMap::new();
    let mut queue = std::collections::VecDeque::from([(start.to_owned(), vec![start.to_owned()])]);
    while let Some((holder, path)) = queue.pop_front() {
        for link in links
            .iter()
            .filter(|link| link.member == holder && !path.contains(&link.container))
        {
            if !paths.contains_key(&link.container) {
                let mut next = path.clone();
                next.push(link.container.clone());
                paths.insert(link.container.clone(), next.clone());
                queue.push_back((link.container.clone(), next));
            }
        }
    }
    paths
}
#[cfg(test)]
mod tests {
    use super::*;
    fn edge(member: &str, container: &str) -> AccessLink {
        AccessLink {
            member: member.into(),
            container: container.into(),
            mode: "member".into(),
            source_span: SourceSpan {
                file: "test".into(),
                line: 1,
                quote: "membership".into(),
            },
        }
    }
    #[test]
    fn changes_collapse_duplicate_edges_with_last_provenance_and_first_key_order() {
        let mut last = edge("jade", "mafia");
        last.source_span.quote = "last authored membership".into();
        let links = vec![edge("jade", "mafia"), edge("mafia", "board"), last];
        let revoke = AccessChange {
            action: AccessAction::Revoke,
            member: "jade".into(),
            container: "mafia".into(),
            reason: None,
        };
        let revoked = apply_change(&links, &revoke);
        assert!(resolve_paths("jade", &revoked).is_empty());
        assert_eq!(revoked.len(), 1);
        let grant = AccessChange {
            action: AccessAction::Grant,
            reason: Some("runtime grant".into()),
            ..revoke
        };
        let granted = apply_change(&links, &grant);
        assert_eq!(granted.len(), 2);
        assert_eq!(granted[0].member, "jade");
        assert_eq!(granted[0].source_span.quote, "runtime grant");
        assert_eq!(granted[1].member, "mafia");
        let unrelated = AccessChange {
            action: AccessAction::Revoke,
            member: "absent".into(),
            container: "absent".into(),
            reason: None,
        };
        let collapsed = apply_change(&links, &unrelated);
        assert_eq!(collapsed[0].source_span.quote, "last authored membership");
        assert_eq!(links.len(), 3);
    }
    #[test]
    fn nested_membership_is_downward_and_cycles_fail_without_mutating_the_graph() {
        let links = vec![edge("jade", "inner-circle"), edge("inner-circle", "mafia")];
        assert_valid_graph(&links).unwrap();
        assert_eq!(
            resolve_paths("jade", &links).get("mafia").unwrap(),
            &vec!["jade", "inner-circle", "mafia"]
        );
        assert!(resolve_paths("mafia", &links).is_empty());
        assert!(
            apply_validated_change(
                &links,
                &AccessChange {
                    action: AccessAction::Grant,
                    member: "mafia".into(),
                    container: "jade".into(),
                    reason: None
                }
            )
            .is_err()
        );
        assert_eq!(links.len(), 2);
        let revoked = apply_validated_change(
            &links,
            &AccessChange {
                action: AccessAction::Revoke,
                member: "jade".into(),
                container: "inner-circle".into(),
                reason: None,
            },
        )
        .unwrap();
        assert!(resolve_paths("jade", &revoked).is_empty());
    }
}
