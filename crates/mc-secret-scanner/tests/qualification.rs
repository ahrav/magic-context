use std::collections::BTreeSet;

use mc_secret_scanner::{ScanProfile, Scanner};
use serde::Deserialize;

#[derive(Deserialize)]
struct Manifest {
    schema: String,
    status: String,
    authority_qualified: bool,
    fixture_cases: usize,
    planned_scan_quota: usize,
    cells: Vec<Cell>,
}

#[derive(Deserialize)]
struct Cell {
    cell_id: String,
    feasibility: String,
    quota: usize,
}

#[derive(Deserialize)]
struct Fixture {
    cell_id: String,
    input: String,
    expected_rule_ids: Vec<String>,
    consent: String,
}

#[test]
fn minimal_fixture_is_truthful_and_executable() {
    let manifest: Manifest =
        serde_json::from_str(include_str!("fixtures/qualification-manifest-v1.json")).unwrap();
    assert_eq!(
        manifest.schema,
        "magic-context.secret-scanner-qualification-manifest/v1"
    );
    assert_eq!(manifest.status, "tooling_only");
    assert!(!manifest.authority_qualified);
    assert_eq!(manifest.planned_scan_quota, 0);
    assert_eq!(manifest.cells.len(), 16);
    assert!(manifest
        .cells
        .iter()
        .all(|cell| cell.feasibility == "unassessed" && cell.quota == 0));

    let fixtures: Vec<Fixture> = include_str!("fixtures/qualification-v1.jsonl")
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(fixtures.len(), manifest.fixture_cases);
    let scanner = Scanner::new(ScanProfile::Comprehensive).unwrap();
    for fixture in fixtures {
        assert_eq!(fixture.consent, "synthetic");
        assert!(manifest
            .cells
            .iter()
            .any(|cell| cell.cell_id == fixture.cell_id));
        let observed_rule_ids = scanner
            .scan(&fixture.input)
            .unwrap()
            .findings
            .into_iter()
            .map(|finding| finding.rule_id)
            .collect::<BTreeSet<_>>();
        let expected_rule_ids = fixture
            .expected_rule_ids
            .into_iter()
            .collect::<BTreeSet<_>>();
        assert_eq!(observed_rule_ids, expected_rule_ids);
    }
}
