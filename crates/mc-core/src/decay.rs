//!
//!
//!

/// Half-life (in compartments) for importance 50 at pressure 1.
pub const H50: f64 = 24.0;
/// Importance points needed to double the half-life (imp 75 → 2×, 100 → 4×).
pub const D: f64 = 25.0;
pub const G: f64 = 2.0;

/// P1→P2 boundary.
pub const Z1: f64 = 0.201;
/// P2→P3 boundary.
pub const Z2: f64 = 0.729;
/// P3→P4 boundary.
pub const Z3: f64 = 1.322;
/// P4→P5 (archive candidate) boundary.
pub const Z4: f64 = 2.587;

/// Pressure floor: prevents div-by-zero and caps relaxation at 10×.
pub const P_FLOOR: f64 = 0.1;

/// Tier costs indexed by tier number; index 0 is reserved.
pub const TIER_COST: [u32; 6] = [0, 322, 109, 35, 20, 5];

/// A paraphrase tier represented by values 1 through 5.
pub type Tier = u8;

#[derive(Debug, Clone, Copy)]
pub struct DecayInput {
    /// 1-based position from newest (1 = newest).
    pub index: u32,
    /// Importance used to compute the decay rate; values clamp to 1 through 100.
    pub importance: i32,
}

#[inline]
fn clamp_importance(importance: i32) -> f64 {
    importance.clamp(1, 100) as f64
}

#[inline]
fn z_value(compartment_index: u32, importance: i32, budget_pressure: f64) -> f64 {
    let a = (compartment_index.max(1) - 1) as f64;
    let imp = clamp_importance(importance);
    let p = budget_pressure.max(P_FLOOR);
    let f = 2f64.powf((imp - 50.0) / D);
    let h = (H50 * f) / p;
    a / h
}

///
/// `compartment_index` is 1-based from newest (1 = newest); `importance` clamps to 1 through 100.
/// `budget_pressure` is clamped to at least 0.10.
pub fn tier(compartment_index: u32, importance: i32, budget_pressure: f64) -> Tier {
    let z = z_value(compartment_index, importance, budget_pressure);
    if z < Z1 {
        1
    } else if z < Z2 {
        2
    } else if z < Z3 {
        3
    } else if z < Z4 {
        4
    } else {
        5
    }
}

/// P5 denotes archival and is not rendered.
/// Anchor overlap raises the archive threshold by up to [`G`] half-lives.
/// With `anchor_overlap = 0.0`, archiving requires `z >= Z4`.
pub fn should_archive(
    compartment_index: u32,
    importance: i32,
    budget_pressure: f64,
    anchor_overlap: f64,
) -> bool {
    let z = z_value(compartment_index, importance, budget_pressure);
    let o = anchor_overlap.clamp(0.0, 1.0);
    z >= Z4 + G * o
}

/// P5 denotes archival, not a verbosity tier.
pub fn rendered_tier(
    compartment_index: u32,
    importance: i32,
    budget_pressure: f64,
    anchor_overlap: f64,
) -> Tier {
    if should_archive(
        compartment_index,
        importance,
        budget_pressure,
        anchor_overlap,
    ) {
        return 5;
    }
    tier(compartment_index, importance, budget_pressure).min(4)
}

/// `H ∝ 1/p`, the per-tier compartment counts scale as `1/p`, so `C(p) ≈ C(1)/p`;
/// Before applying [`P_FLOOR`], `p = C(1)/B` targets cost `B` under this approximation.
/// budgets (<8K).
pub fn compute_budget_pressure(compartments: &[DecayInput], history_budget: f64) -> f64 {
    if history_budget <= 0.0 {
        return 1.0;
    }
    let mut natural_cost = 0.0;
    for c in compartments {
        let natural_tier = tier(c.index, c.importance, 1.0);
        if natural_tier < 5 {
            natural_cost += TIER_COST[natural_tier as usize] as f64;
        }
    }
    (natural_cost / history_budget).max(P_FLOOR)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[test]
    fn newest_compartment_is_tier_1() {
        for imp in [1, 50, 100] {
            for p in [0.1, 1.0, 5.0] {
                assert_eq!(tier(1, imp, p), 1);
            }
        }
    }

    #[test]
    fn age_monotonic_demotion() {
        // for fixed importance/pressure, tier is non-decreasing in age.
        let mut prev = 0u8;
        for idx in 1..=400u32 {
            let t = tier(idx, 50, 1.0);
            assert!(t >= prev, "tier decreased with age at idx {idx}");
            prev = t;
        }
    }

    #[test]
    fn importance_protects_against_demotion() {
        // higher importance → same-or-lower tier (more protection) at fixed age/pressure.
        for idx in [10u32, 50, 200] {
            let lo = tier(idx, 10, 1.0);
            let hi = tier(idx, 90, 1.0);
            assert!(hi <= lo, "higher importance demoted faster at idx {idx}");
        }
    }

    #[test]
    fn pressure_accelerates_demotion() {
        for idx in [10u32, 50, 200] {
            let lo = tier(idx, 50, 0.5);
            let hi = tier(idx, 50, 4.0);
            assert!(hi >= lo, "higher pressure protected more at idx {idx}");
        }
    }

    #[test]
    fn finite_demotion_at_max_importance() {
        // Importance 100 reaches the archive threshold at a finite compartment index.
        assert!(should_archive(100_000, 100, 1.0, 0.0));
    }

    #[test]
    fn rendered_tier_caps_at_four_unless_archived() {
        for idx in 1..=500u32 {
            let rt = rendered_tier(idx, 50, 1.0, 0.0);
            assert!(rt == 5 || rt <= 4);
        }
    }

    #[test]
    fn pressure_self_tunes_toward_budget() {
        let comps: Vec<DecayInput> = (1..=200)
            .map(|i| DecayInput {
                index: i,
                importance: 50,
            })
            .collect();
        // For nonzero natural cost and `history_budget > 0`, pressure increases as the budget decreases, subject to [`P_FLOOR`].
        let loose = compute_budget_pressure(&comps, 20_000.0);
        let tight = compute_budget_pressure(&comps, 2_000.0);
        assert!(tight > loose);
        assert!(loose >= P_FLOOR);
    }

    #[derive(Deserialize)]
    struct TierCase {
        index: u32,
        importance: i32,
        pressure: f64,
        tier: u8,
        archived: bool,
        rendered: u8,
    }
    #[derive(Deserialize)]
    struct PressureCase {
        importances: Vec<i32>,
        budget: f64,
        one_pass: f64,
    }
    #[derive(Deserialize)]
    struct Golden {
        tier_cases: Vec<TierCase>,
        pressure_cases: Vec<PressureCase>,
    }

    #[test]
    fn decay_golden_matches_reference() {
        let raw = include_str!("../testdata/decay-golden.json");
        let golden: Golden = serde_json::from_str(raw).expect("parse decay-golden.json");
        assert!(!golden.tier_cases.is_empty(), "empty tier grid");

        for c in &golden.tier_cases {
            assert_eq!(
                tier(c.index, c.importance, c.pressure),
                c.tier,
                "tier mismatch at idx={} imp={} p={}",
                c.index,
                c.importance,
                c.pressure
            );
            assert_eq!(
                should_archive(c.index, c.importance, c.pressure, 0.0),
                c.archived,
                "archive mismatch at idx={} imp={} p={}",
                c.index,
                c.importance,
                c.pressure
            );
            assert_eq!(
                rendered_tier(c.index, c.importance, c.pressure, 0.0),
                c.rendered,
                "rendered mismatch at idx={} imp={} p={}",
                c.index,
                c.importance,
                c.pressure
            );
        }

        for c in &golden.pressure_cases {
            let comps: Vec<DecayInput> = c
                .importances
                .iter()
                .enumerate()
                .map(|(i, &imp)| DecayInput {
                    index: (i + 1) as u32,
                    importance: imp,
                })
                .collect();
            let one = compute_budget_pressure(&comps, c.budget);
            assert!(
                (one - c.one_pass).abs() < 1e-9,
                "one-pass pressure mismatch: rust={one} ts={} budget={}",
                c.one_pass,
                c.budget
            );
        }
    }
}
