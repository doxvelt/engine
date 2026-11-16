use doxvelt_engine::{
    acceptance::accept_actor_draft,
    application::{StartRequest, start_from_source},
    commands::{commit_effects, commit_manual_turn},
    drafts::{PrepareOptions, finish_preserved, finish_runtime, prepare_actor_draft},
    identity::domain_id,
    model::{AcceptRequest, Command},
    routing::project_routing_context,
    runtime::RuntimeStream,
    storage::Store,
};
use serde_json::{Value, json};
use std::path::Path;

fn fixture() -> Store {
    let mut store = Store::open(Path::new(":memory:")).unwrap();
    let start = start_from_source(
        &mut store,
        StartRequest {
            owner_scope: "local",
            simulation_id: "routing",
            command_id: "start",
            scenario_id: Some("last-crossing".into()),
            branch_id: Some("main".into()),
        },
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/last-crossing"),
    )
    .unwrap();
    let presence=commit_effects(&mut store,Command {owner_scope:"local".into(),simulation_id:"routing".into(),branch_id:"main".into(),command_id:"presence".into(),expected_head:start.root.id,
        payload:json!({"audienceChanges":[{"actorId":"corin","action":"add"},{"actorId":"mara","action":"add"}]})}).unwrap();
    commit_manual_turn(&mut store,Command {owner_scope:"local".into(),simulation_id:"routing".into(),branch_id:"main".into(),command_id:"turn".into(),expected_head:presence.commit.id,
        payload:json!({"actorId":"corin","audience":["mara"],"text":"A received statement remains a claim.","knowledgePolicy":"actor-knowledge-v1"})}).unwrap();
    store
}
#[test]
fn routed_context_and_prompt_match_the_reference_for_all_four_policies_and_recalled_memory() {
    let cases: Vec<Value> = serde_json::from_str(include_str!("fixtures/routing.json")).unwrap();
    for (index, case) in cases.into_iter().enumerate() {
        let mut store = fixture();
        let command: Command = serde_json::from_value(case["command"].clone()).unwrap();
        assert_eq!(
            command.expected_head,
            domain_id("commit", &["local", "routing", "turn"])
        );
        let result = project_routing_context(
            &store,
            &command,
            &[],
            case.get("source").filter(|v| !v.is_null()),
            case.get("recall").filter(|v| !v.is_null()),
        )
        .unwrap();
        let expected = &case["expected"];
        // Frozen retry identity requires exact bytes in both prompt and
        // canonical context, so the reference hashes are the compatibility contract.
        assert_eq!(
            result.context_hash,
            expected["contextHash"].as_str().unwrap()
        );
        assert_eq!(result.prompt_hash, expected["promptHash"].as_str().unwrap());
        assert_eq!(
            json!(result.available_recipient_ids),
            expected["availableRecipientIds"]
        );
        if case["source"].is_null() && command.payload["routing"]["version"].as_f64() != Some(4.0) {
            let mut command = command;
            command.command_id = format!("generate-{index}");
            let prepared = prepare_actor_draft(
                &mut store,
                command.clone(),
                PrepareOptions {
                    episode_recall: case.get("recall").filter(|v| !v.is_null()),
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(!prepared.replayed);
            assert_eq!(prepared.draft["promptHash"], expected["promptHash"]);
            assert_eq!(prepared.draft["contextHash"], expected["contextHash"]);
            let mut stream = RuntimeStream::default();
            stream.push(&json!({"type":"completed","text":"{\"text\":\"Candidate.\",\"audience\":[\"corin\",\"mara\"]}","usage":{"inputTokens":1,"outputTokens":2,"totalTokens":3},"stopReason":"stop"})).unwrap();
            let ready = finish_runtime(
                &mut store,
                &prepared.draft,
                &json!({"id":"test-adapter","version":"v1"}),
                stream.finish(),
            )
            .unwrap();
            assert_eq!(ready["status"], "ready");
            assert_eq!(ready["artifact"]["text"], "Candidate.");
            assert!(
                prepare_actor_draft(&mut store, command.clone(), PrepareOptions::default())
                    .unwrap()
                    .replayed
            );
            let mut correction = command;
            correction.command_id = format!("preserved-{index}");
            correction.payload["routing"]["sourceDraftId"] = ready["id"].clone();
            correction.payload["routing"]["correctedAudience"] = json!(["mara"]);
            correction.payload["routing"]["preservedText"] = json!("Director wording.");
            let replacement =
                prepare_actor_draft(&mut store, correction, PrepareOptions::default()).unwrap();
            let preserved = finish_preserved(&mut store, &replacement.draft)
                .unwrap()
                .unwrap();
            assert_eq!(preserved["status"], "ready");
            assert_eq!(
                preserved["artifact"]["provenance"]["adapter"]["id"],
                "director-preserved"
            );
            assert_eq!(
                preserved["artifact"]["provenance"]["usage"]["totalTokens"],
                0
            );
            let request = AcceptRequest {
                owner_scope: "local".into(),
                simulation_id: "routing".into(),
                draft_id: preserved["id"].as_str().unwrap().into(),
                command_id: format!("accept-{index}"),
                final_text: None,
            };
            let accepted = accept_actor_draft(&mut store, request.clone()).unwrap();
            assert!(!accepted.replayed);
            assert_eq!(
                accepted.commit.events[0]["message"]["text"],
                "Director wording."
            );
            assert_eq!(
                accepted.commit.events[0]["message"]["provenance"]["finalTextSource"],
                "director_preserved"
            );
            assert!(accept_actor_draft(&mut store, request).unwrap().replayed);
        }
    }
}
