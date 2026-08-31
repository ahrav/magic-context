use std::collections::{BTreeMap, HashMap, HashSet};

use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde::Serialize;

use super::read::{load_observations, snapshot_tip};
use crate::kernel::envelope::{
    check_fence, replace_alignment_projection_tx, AlignmentProjectionSpec,
};
use crate::kernel::{KernelError, KernelStore};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignmentRow {
    pub decision_id: String,
    pub observation_id: String,
    pub alignment_kind: String,
    pub alignment_payload: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlignmentSnapshot {
    pub known_as_of: i64,
    pub tip: i64,
    pub rows: Vec<AlignmentRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AlignmentRebuild {
    pub built_through_commit_seq: i64,
    pub rows: usize,
    pub published: bool,
}

#[derive(Debug)]
struct AlignmentInput {
    known_as_of: i64,
    tip: i64,
    decisions: HashMap<String, DecisionHistory>,
    observations: HashMap<String, ObservationInput>,
    dependencies: Vec<Dependency>,
}

#[derive(Debug)]
struct DecisionHistory {
    decision_id: String,
    invalidated_commit_seq: Option<i64>,
    superseded_by: Option<String>,
}

#[derive(Debug)]
struct ObservationInput {
    observation_id: String,
    alignment_kind: String,
}

#[derive(Debug)]
struct Dependency {
    observation_id: String,
    decision_object_id: String,
}

#[derive(Serialize)]
struct AlignmentPayload<'a> {
    decision_id: &'a str,
    observation_id: &'a str,
    alignment_kind: &'a str,
}

impl KernelStore {
    pub fn alignment_as_of(&self, requested: i64) -> Result<AlignmentSnapshot, KernelError> {
        let mut reader = self.lock_reader()?;
        let tx = reader
            .transaction_with_behavior(TransactionBehavior::Deferred)
            .map_err(|_| KernelError::Io)?;
        let input = load_alignment_input(&tx, requested)?;
        tx.commit().map_err(|_| KernelError::Io)?;
        derive_alignment(input)
    }

    pub fn rebuild_alignment(&self) -> Result<AlignmentRebuild, KernelError> {
        let mut writer = self.lock_writer()?;
        rebuild_alignment_with_writer(&mut writer, self.lease_epoch())
    }
}

pub(crate) fn rebuild_alignment_with_writer(
    writer: &mut Connection,
    lease_epoch: u64,
) -> Result<AlignmentRebuild, KernelError> {
    let tx = writer
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| KernelError::Io)?;
    check_fence(&tx, lease_epoch)?;
    let tip = tx
        .query_row(
            "SELECT COALESCE(MAX(commit_seq),0) FROM commit_log",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| KernelError::Io)?;
    if tip == 0 {
        tx.commit().map_err(|_| KernelError::Io)?;
        return Ok(AlignmentRebuild {
            built_through_commit_seq: 0,
            rows: 0,
            published: false,
        });
    }
    let rows = derive_alignment(load_alignment_input(&tx, tip)?)?.rows;
    let specs = rows
        .into_iter()
        .map(|row| AlignmentProjectionSpec {
            decision_id: row.decision_id,
            observation_id: row.observation_id,
            alignment_kind: row.alignment_kind,
            alignment_payload: Some(row.alignment_payload),
            built_through_commit_seq: tip,
        })
        .collect::<Vec<_>>();
    let result = replace_alignment_projection_tx(&tx, &specs)?;
    tx.commit().map_err(|_| KernelError::Io)?;
    Ok(AlignmentRebuild {
        built_through_commit_seq: tip,
        rows: result.rows,
        published: true,
    })
}

fn load_alignment_input(
    tx: &Transaction<'_>,
    requested: i64,
) -> Result<AlignmentInput, KernelError> {
    let tip = snapshot_tip(tx, requested)?;
    let decisions = {
        let mut statement = tx
            .prepare(
                "SELECT decision_id,object_id,
                        CASE WHEN invalidated_commit_seq<=?1 THEN invalidated_commit_seq END,
                        CASE WHEN invalidated_commit_seq<=?1 THEN superseded_by END
                 FROM decisions
                 WHERE created_commit_seq<=?1
                 ORDER BY object_id",
            )
            .map_err(|_| KernelError::Io)?;
        let rows = statement
            .query_map([requested], |row| {
                Ok((
                    row.get::<_, String>(1)?,
                    DecisionHistory {
                        decision_id: row.get(0)?,
                        invalidated_commit_seq: row.get(2)?,
                        superseded_by: row.get(3)?,
                    },
                ))
            })
            .map_err(|_| KernelError::Io)?
            .collect::<rusqlite::Result<HashMap<_, _>>>()
            .map_err(|_| KernelError::Io)?;
        rows
    };
    let observations = load_observations(tx, requested)?
        .into_iter()
        .map(|row| {
            (
                row.observation_id.clone(),
                ObservationInput {
                    observation_id: row.observation_id,
                    alignment_kind: row.payload.classification,
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let dependencies = {
        let mut statement = tx
            .prepare(
                "SELECT d.observation_id,d.dependency_object_id
                 FROM observation_dependencies d
                 JOIN observations o USING(observation_id)
                 WHERE d.dependency_kind='implements'
                   AND o.created_commit_seq<=?1
                   AND (o.invalidated_commit_seq IS NULL OR ?1<o.invalidated_commit_seq)
                 ORDER BY d.observation_id,d.dependency_object_id",
            )
            .map_err(|_| KernelError::Io)?;
        let rows = statement
            .query_map([requested], |row| {
                Ok(Dependency {
                    observation_id: row.get(0)?,
                    decision_object_id: row.get(1)?,
                })
            })
            .map_err(|_| KernelError::Io)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|_| KernelError::Io)?;
        rows
    };
    Ok(AlignmentInput {
        known_as_of: requested,
        tip,
        decisions,
        observations,
        dependencies,
    })
}

fn derive_alignment(input: AlignmentInput) -> Result<AlignmentSnapshot, KernelError> {
    let mut rows = BTreeMap::new();
    for dependency in &input.dependencies {
        let Some(observation) = input.observations.get(&dependency.observation_id) else {
            return Err(KernelError::Conflict);
        };
        let Some(decision) = resolve_decision(&input.decisions, &dependency.decision_object_id)?
        else {
            continue;
        };
        let payload = serde_json::to_string(&AlignmentPayload {
            decision_id: &decision.decision_id,
            observation_id: &observation.observation_id,
            alignment_kind: &observation.alignment_kind,
        })
        .map_err(|_| KernelError::InvalidInput)?;
        let row = AlignmentRow {
            decision_id: decision.decision_id.clone(),
            observation_id: observation.observation_id.clone(),
            alignment_kind: observation.alignment_kind.clone(),
            alignment_payload: payload,
        };
        let key = (row.decision_id.clone(), row.observation_id.clone());
        if let Some(existing) = rows.insert(key, row.clone()) {
            if existing != row {
                return Err(KernelError::Conflict);
            }
        }
    }
    Ok(AlignmentSnapshot {
        known_as_of: input.known_as_of,
        tip: input.tip,
        rows: rows.into_values().collect(),
    })
}

fn resolve_decision<'a>(
    decisions: &'a HashMap<String, DecisionHistory>,
    object_id: &str,
) -> Result<Option<&'a DecisionHistory>, KernelError> {
    let mut current = object_id;
    let mut visited = HashSet::new();
    loop {
        if !visited.insert(current) {
            return Err(KernelError::Conflict);
        }
        let Some(decision) = decisions.get(current) else {
            return Ok(None);
        };
        if decision.invalidated_commit_seq.is_none() {
            return Ok(Some(decision));
        }
        let Some(successor) = decision.superseded_by.as_deref() else {
            return Ok(None);
        };
        current = successor;
    }
}
