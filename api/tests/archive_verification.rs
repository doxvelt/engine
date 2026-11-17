use doxvelt_engine::{
    archive::{self, verify::decode_archive},
    identity::fingerprint,
};
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    serde_json::from_str::<Value>(include_str!("fixtures/archives.json")).unwrap()[name].clone()
}
fn verify(value: &Value) -> doxvelt_engine::error::Result<()> {
    archive::validate(&decode_archive(value)?)
}

#[test]
fn indexed_ancestry_matches_walks_on_every_path_and_rejects_disconnected_cycles() {
    use doxvelt_engine::ports::SimulationReader;
    let mut data = decode_archive(&fixture("complete")).unwrap();
    let reader = archive::ArchiveReader::new(&data);
    for head in &data.commits {
        let path = reader
            .ancestry(&head.owner_scope, &head.simulation_id, &head.id)
            .unwrap();
        for base in &data.commits {
            assert_eq!(
                reader.is_ancestor(&base.id, &head.id).unwrap(),
                path.iter().any(|c| c.id == base.id)
            );
        }
        assert!(!reader.is_ancestor("absent", &head.id).unwrap());
    }
    assert!(reader.is_ancestor(&data.commits[0].id, "absent").is_err());
    let mut disconnected = data.commits[0].clone();
    disconnected.id = "disconnected".into();
    disconnected.parent_commit_id = Some(disconnected.id.clone());
    data.commits.push(disconnected);
    assert!(
        archive::ArchiveReader::new(&data)
            .is_ancestor(&data.commits[0].id, &data.commits[0].id)
            .is_err()
    );
}

#[test]
fn cancellation_during_validation_and_import_leaves_no_simulation_and_can_retry() {
    use doxvelt_engine::storage::Store;
    use std::{cell::Cell, path::Path};
    let data = decode_archive(&fixture("complete")).unwrap();
    let calls = Cell::new(0usize);
    archive::validate_cancellable(&data, &|| {
        calls.set(calls.get() + 1);
        false
    })
    .unwrap();
    let total = calls.get();
    assert!(total > data.commits.len() * 4);
    // Stop within indexing, later semantic validation, and transactional insert.
    for limit in [data.commits.len() / 2, total / 2, total + 10] {
        let calls = Cell::new(0usize);
        let cancel = || {
            calls.set(calls.get() + 1);
            calls.get() > limit
        };
        let mut store = Store::open(Path::new(":memory:")).unwrap();
        let error = store
            .import_simulation_cancellable(data.clone(), &cancel)
            .unwrap_err();
        assert!(error.message.contains("cancelled"), "{error:?}");
        assert!(
            store
                .export_simulation(&data.simulation.owner_scope, &data.simulation.id)
                .is_err()
        );
        store.import_simulation(data.clone()).unwrap();
        assert_eq!(
            json!(
                store
                    .export_simulation(&data.simulation.owner_scope, &data.simulation.id)
                    .unwrap()
            ),
            json!(data)
        );
    }
}

#[test]
fn accepted_history_from_the_reference_verifies_without_operational_rows_or_host_resources() {
    for name in ["memory", "complete"] {
        verify(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {e:?}"));
    }
}
fn sync_commit(value: &mut Value, index: usize) {
    let commit = value["commits"][index].clone();
    let command = value["commandResults"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["commandId"] == commit["commandId"])
        .unwrap();
    command["result"]["commit"] = commit;
}
#[test]
fn immutable_events_cannot_be_forged_by_rewriting_their_cached_outcome() {
    let mut value = fixture("complete");
    let index = value["commits"]
        .as_array()
        .unwrap()
        .iter()
        .position(|c| c["commandId"] == "original")
        .unwrap();
    value["commits"][index]["events"][0]["message"]["text"] = json!("Forged original.");
    sync_commit(&mut value, index);
    assert!(verify(&value).is_err());
}
#[test]
fn imported_generated_context_hashes_remain_recorded_claims_without_prompt_preimages() {
    let mut value = fixture("complete");
    let command = value["commandResults"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|c| c["canonicalInput"]["kind"] == "accept_draft")
        .unwrap();
    command["canonicalInput"]["payload"]["contextHash"] = json!("a".repeat(64));
    command["fingerprint"] = json!(fingerprint(&command["canonicalInput"]));
    verify(&value).unwrap();
}

#[test]
fn malformed_and_self_consistently_rehashed_archives_match_the_reference_verdicts() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/archive-mutations.json")).unwrap();
    for case in cases {
        let mut archive = fixture("complete");
        for change in case["changes"].as_array().unwrap() {
            let path = change["path"].as_array().unwrap();
            let mut target = &mut archive;
            for key in &path[..path.len() - 1] {
                target = if let Some(index) = key.as_u64() {
                    &mut target[index as usize]
                } else {
                    &mut target[key.as_str().unwrap()]
                };
            }
            let key = path.last().unwrap();
            if change["remove"] == true {
                target
                    .as_object_mut()
                    .unwrap()
                    .remove(key.as_str().unwrap());
            } else if let Some(index) = key.as_u64() {
                target[index as usize] = change["value"].clone();
            } else {
                target[key.as_str().unwrap()] = change["value"].clone();
            }
        }
        let verdict = verify(&archive);
        assert_eq!(
            verdict.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {verdict:?}",
            case["name"]
        );
    }
}

#[test]
fn legacy_conversion_validates_results_before_replacing_them_with_checkpoints() {
    let mut raw = fixture("memory");
    raw["schemaVersion"] = json!(4);
    let result = raw["memoryJobs"][0]["result"].clone();
    let index = raw["commits"]
        .as_array()
        .unwrap()
        .iter()
        .position(|c| c["kind"] == "episode_closure")
        .unwrap();
    raw["commits"][index]["events"][0]["closure"] = result;
    sync_commit(&mut raw, index);
    for key in [
        "memoryJobs",
        "memoryJobTransitions",
        "detachedMemoryOperations",
    ] {
        raw.as_object_mut().unwrap().remove(key);
    }
    let converted = archive::normalize(decode_archive(&raw).unwrap()).unwrap();
    let expected: Value = serde_json::from_str(include_str!("fixtures/archives.json")).unwrap();
    assert_eq!(
        fingerprint(&json!(converted)),
        expected["legacyConversionHash"]
    );
    raw["commits"][index]["events"][0]["closure"]["memories"][0]["actorId"] = json!("missing");
    sync_commit(&mut raw, index);
    assert!(verify(&raw).is_err());
}

#[test]
fn native_import_export_roundtrips_accepted_history_without_operational_drafts() {
    use doxvelt_engine::{model::AcceptRequest, storage::Store};
    use std::path::Path;
    let original = fixture("complete");
    let mut store = Store::open(Path::new(":memory:")).unwrap();
    store
        .import_simulation(decode_archive(&original).unwrap())
        .unwrap();
    let exported = store.export_simulation("owner", "archive").unwrap();
    assert_eq!(json!(exported), original);
    archive::validate(&exported).unwrap();
    let accepted = exported
        .command_results
        .iter()
        .find(|c| c.canonical_input["kind"] == "accept_draft")
        .unwrap();
    let draft = accepted.canonical_input["payload"]["draftId"]
        .as_str()
        .unwrap();
    assert!(
        store
            .actor_draft("owner", "archive", draft)
            .unwrap()
            .is_none()
    );
    let replay = store
        .replay_accepted_draft(&AcceptRequest {
            owner_scope: "owner".into(),
            simulation_id: "archive".into(),
            draft_id: draft.into(),
            command_id: accepted.command_id.clone(),
            final_text: Some(
                accepted.canonical_input["payload"]["accepted"]["text"]
                    .as_str()
                    .unwrap()
                    .into(),
            ),
        })
        .unwrap()
        .unwrap();
    assert!(replay.replayed);
    assert!(
        store
            .import_simulation(decode_archive(&original).unwrap())
            .is_err()
    );
    assert_eq!(
        json!(store.export_simulation("owner", "archive").unwrap()),
        original
    );
}
