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
    let mut next = links.to_vec();
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
