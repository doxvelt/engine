use doxvelt_engine::{
    archive,
    episode_memory::{self, EpisodeCatalog, EpisodeQuery, FormationPlan},
    storage::Store,
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path};

#[test]
fn episode_sources_dates_revisions_and_branch_eligibility_match_the_reference() {
    let archives: Value = serde_json::from_str(include_str!("fixtures/archives.json")).unwrap();
    let reference: Value =
        serde_json::from_str(include_str!("fixtures/episode-memory.json")).unwrap();
    let mut store = Store::open(Path::new(":memory:")).unwrap();
    store
        .import_simulation(archive::verify::decode_archive(&archives["complete"]).unwrap())
        .unwrap();
    let root = std::env::temp_dir().join(format!("doxvelt-native-memory-{}", uuid::Uuid::new_v4()));
    let catalog = EpisodeCatalog::open(&root).unwrap();
    for case in reference["cases"].as_array().unwrap() {
        let q: EpisodeQuery = serde_json::from_value(case["query"].clone()).unwrap();
        let dates: HashMap<String, String> = serde_json::from_value(case["dates"].clone()).unwrap();
        assert_eq!(
            json!(episode_memory::scenes(&store, &q, &dates).unwrap()),
            case["scenes"],
            "{}",
            case["name"]
        );
        if case["name"] == "dated" {
            for (slot, date) in dates {
                catalog.set_date(&store, &q, &slot, &date).unwrap();
            }
        }
        if case["name"] == "published" {
            let plan = match catalog.prepare_memorize(&store, &q, "first").unwrap() {
                FormationPlan::New(p) => p,
                _ => panic!("Unexpected existing publication"),
            };
            assert_eq!(plan.id, reference["publication"]["id"]);
            let (result, inserted) = catalog.publish(&q, &reference["publication"]).unwrap();
            assert!(inserted);
            assert_eq!(result["status"], "published");
            assert!(matches!(
                catalog.prepare_memorize(&store, &q, "first").unwrap(),
                FormationPlan::Current(_)
            ));
        }
        assert_eq!(
            json!(catalog.inspect(&store, &q).unwrap()),
            case["inspect"],
            "{}",
            case["name"]
        );
    }
    drop(catalog);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn stale_dependencies_are_excluded_transitively_and_dates_are_strict() {
    assert_eq!(
        doxvelt_engine::identity::js_trim("\u{feff}named\u{a0}"),
        "named"
    );
    assert_eq!(
        doxvelt_engine::identity::js_trim("\u{85}named\u{85}"),
        "\u{85}named\u{85}"
    );
    for date in ["2024-02-29", "0000-01-01", "9999-12-31"] {
        episode_memory::require_date(date).unwrap();
    }
    for date in [
        "2023-02-29",
        "2000-02-30",
        " 2000-01-01",
        "2000-1-01",
        "10000-01-01",
    ] {
        assert!(episode_memory::require_date(date).is_err(), "{date}");
    }
    let scene = |slot: &str, date: &str, revision: &str| episode_memory::Scene {
        slot: slot.into(),
        date: Some(date.into()),
        revision: revision.into(),
        label: slot.into(),
        episode_id: None,
        sources: vec![],
    };
    let scenes = vec![
        scene("first", "2000-01-01", "new"),
        scene("second", "2001-01-01", "second"),
        scene("third", "2002-01-01", "third"),
    ];
    let pubs = vec![
        json!({"id":"third","revision":"third","dependencies":["second"]}),
        json!({"id":"second","revision":"second","dependencies":["old"]}),
        json!({"id":"old","revision":"old","dependencies":[]}),
    ];
    assert!(episode_memory::resolve(&scenes, &pubs).is_empty());
}
