use doxvelt_engine::{
    alternatives::{self, view::HistoricalDraftRepository},
    archive,
    commands::commit_manual_turn,
    drafts::{self, PrepareOptions},
    model::Command,
    projection::project_branch,
    runtime::RuntimeStream,
    storage::Store,
};
use serde_json::{Value, json};
use std::path::Path;
fn fixture() -> Store {
    let value: Value = serde_json::from_str(include_str!("fixtures/archives.json")).unwrap();
    let mut store = Store::open(Path::new(":memory:")).unwrap();
    store
        .import_simulation(archive::verify::decode_archive(&value["complete"]).unwrap())
        .unwrap();
    store
}
fn request(store: &Store, command: &str, manual: bool) -> Value {
    let source = store.export_simulation("owner", "archive").unwrap();
    let turn = source
        .commits
        .iter()
        .find(|c| c.command_id == "original")
        .unwrap();
    let message = &turn.events[0]["message"];
    let mut r = json!({"ownerScope":"owner","simulationId":"archive","commandId":command,"sourceBranchId":"main","expectedHead":store.branch("owner","archive","main").unwrap().unwrap().head_commit_id,"sourceCommitId":turn.id,"messageVersionId":message["id"],"logicalMessageId":message["logicalMessageId"],"actorId":"ceo","action":if manual {"manual"} else {"generate"},"audience":["ceo"]});
    if manual {
        r["manualText"] = json!("An alternate beginning.");
    } else {
        r["completeWhisper"] = json!("Use fresh direction only.");
    }
    r
}
fn generate(store: &mut Store, operation: &Value, text: &str, recall: Option<&Value>) -> Value {
    let command = alternatives::generation_command(operation).unwrap();
    let mut view = HistoricalDraftRepository {
        repository: store,
        operation: operation.clone(),
    };
    let prepared = drafts::prepare_actor_draft(
        &mut view,
        command,
        PrepareOptions {
            episode_recall: recall,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!prepared.replayed);
    let captured = prepared.draft["prompt"].as_str().unwrap();
    for excluded in [
        "A private claim.",
        "Be precise.",
        "Shared #cfo(secret)",
        "Edited generated reply.",
    ] {
        assert!(!captured.contains(excluded), "{excluded}");
    }
    let mut stream = RuntimeStream::default();
    stream
        .push(&json!({"type":"completed","text":text,"stopReason":"stop"}))
        .unwrap();
    drafts::finish_runtime(
        &mut view,
        &prepared.draft,
        &json!({"id":"native-test","version":"v1"}),
        stream.finish(),
    )
    .unwrap()
}
#[test]
fn native_manual_and_generated_alternatives_save_siblings_and_replay_portable_receipts() {
    for manual in [true, false] {
        let mut store = fixture();
        let before = store.branch("owner", "archive", "main").unwrap().unwrap();
        let r = request(
            &store,
            if manual {
                "native-manual"
            } else {
                "native-generated"
            },
            manual,
        );
        let reserved = alternatives::prepare_alternative(&mut store, r.clone(), true).unwrap();
        assert!(!reserved.replayed);
        if !manual {
            let ready = generate(
                &mut store,
                &reserved.operation,
                r#"{"text":"Fresh native wording.","audience":["ceo"]}"#,
                None,
            );
            assert_eq!(ready["status"], "ready");
        }
        let saved = alternatives::finish_alternative(
            &mut store,
            "owner",
            "archive",
            reserved.operation["id"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(saved["status"], "saved");
        assert_eq!(
            store.branch("owner", "archive", "main").unwrap().unwrap(),
            before
        );
        let branch = saved["outcome"]["branchId"].as_str().unwrap();
        let projection = project_branch(&store, "owner", "archive", branch, None).unwrap();
        assert_eq!(projection.transcript.len(), 1);
        assert_eq!(
            projection.transcript[0]["text"],
            if manual {
                "An alternate beginning."
            } else {
                "Fresh native wording."
            }
        );
        let archive = store.export_simulation("owner", "archive").unwrap();
        archive::validate(&archive).unwrap();
        let mut imported = Store::open(Path::new(":memory:")).unwrap();
        imported.import_simulation(archive).unwrap();
        let replay = alternatives::prepare_alternative(&mut imported, r, true).unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.operation["outcome"], saved["outcome"]);
        assert!(replay.operation["draft"].is_null());
    }
}
#[test]
fn historical_retry_uses_frozen_memory_and_discard_prevents_late_completion() {
    let mut store = fixture();
    let r = request(&store, "failed-native", false);
    let reserved = alternatives::prepare_alternative(&mut store, r.clone(), true).unwrap();
    let recall =
        json!([{"publicationId":"prior","label":"Before","text":"A frozen recollection."}]);
    let failed = generate(
        &mut store,
        &reserved.operation,
        "Invalid proposal",
        Some(&recall),
    );
    assert_eq!(failed["status"], "failed");
    let current = alternatives::finish_alternative(
        &mut store,
        "owner",
        "archive",
        reserved.operation["id"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(current["failure"], "generation_failed");
    let mut retry = r;
    retry["commandId"] = json!("retry-native");
    retry["retryOf"] = current["id"].clone();
    let retry = alternatives::prepare_alternative(&mut store, retry, true).unwrap();
    let frozen = doxvelt_engine::routing::captured_episode_recall(
        &retry.retry_source.unwrap()["draft"]["context"],
    )
    .unwrap();
    let command = alternatives::generation_command(&retry.operation).unwrap();
    let mut view = HistoricalDraftRepository {
        repository: &mut store,
        operation: retry.operation.clone(),
    };
    let draft = drafts::prepare_actor_draft(
        &mut view,
        command,
        PrepareOptions {
            episode_recall: frozen.as_ref(),
            ..Default::default()
        },
    )
    .unwrap()
    .draft;
    assert_eq!(draft["promptHash"], failed["promptHash"]);
    assert_eq!(draft["contextHash"], failed["contextHash"]);
    drop(view);
    let id = retry.operation["id"].as_str().unwrap();
    store
        .settle_alternative("owner", "archive", id, "discarded", None)
        .unwrap();
    let mut stream = RuntimeStream::default();
    stream.push(&json!({"type":"completed","text":"{\"text\":\"Late\",\"audience\":[\"ceo\"]}","stopReason":"stop"})).unwrap();
    let mut view = HistoricalDraftRepository {
        repository: &mut store,
        operation: retry.operation,
    };
    let completed = drafts::finish_runtime(
        &mut view,
        &draft,
        &json!({"id":"native-test","version":"v1"}),
        stream.finish(),
    )
    .unwrap();
    assert_eq!(completed["status"], "discarded");
    assert_eq!(
        store
            .export_simulation("owner", "archive")
            .unwrap()
            .branches
            .len(),
        fixture()
            .export_simulation("owner", "archive")
            .unwrap()
            .branches
            .len()
    );
}
#[test]
fn advancing_the_guarded_source_rejects_publication_without_partial_accepted_history() {
    let mut store = fixture();
    let r = request(&store, "stale-native", true);
    let reserved = alternatives::prepare_alternative(&mut store, r.clone(), true).unwrap();
    commit_manual_turn(&mut store,Command {owner_scope:"owner".into(),simulation_id:"archive".into(),branch_id:"main".into(),expected_head:r["expectedHead"].as_str().unwrap().into(),command_id:"advance-native".into(),payload:json!({"actorId":"ceo","text":"Keep the later continuation.","audience":["ceo"],"knowledgePolicy":"actor-knowledge-v1"})}).unwrap();
    let before = store.export_simulation("owner", "archive").unwrap();
    let failed = alternatives::finish_alternative(
        &mut store,
        "owner",
        "archive",
        reserved.operation["id"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(failed["failure"], "validation_failed");
    assert_eq!(
        json!(store.export_simulation("owner", "archive").unwrap()),
        json!(before)
    );
}
