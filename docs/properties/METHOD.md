# Method contract for property-discovery agents

Every agent working on this catalog reads this file first. It is the single source
for the record schema, the check-semantics rules, and the conventions, so
individual task prompts stay short.

Method: `/testing:property-discovery-and-catalog`.

## Non-negotiable rules

1. **Verify every line reference against HEAD before writing it.** Correct any
   that are off and note the correction. If you cannot confirm a claim, record it
   as unresolved rather than restating it as fact.
2. **Never fabricate an answer to clear an open question.** `needs human input` is
   a valid conclusion. So is `unresolved, needs X`.
3. **A documented guarantee is a claim under test.** The documentation establishes
   the contractual obligation. It never establishes that the implementation
   satisfies it. Report contract-versus-code disagreements with both sides cited;
   do not resolve them in favour of the doc.
4. **Verify reachability class per record, at authoring time.** Every record is
   labelled `default-production`, `explicit-config-only`, or `test-only`, with the
   evidence for that label. Do not assert a blanket reachability claim in a
   preamble; that error has already been made once and cost a whole revision.
5. **Touch only the files you are told to create.** Never run a formatter,
   re-wrapper, prettier, or any directory-wide edit. An agent once ran a
   directory-wide re-wrapper and damaged 24 files belonging to other agents.
6. **No fixes.** This is evidence and analysis, not remediation. Do not edit
   source, tests, or CI.
7. **Prose style.** Plain, direct, present tense. Full sentences. No hype, no
   emoji, no em dashes as connectors. Wrap at about 80 columns.

## Record schema

Every catalog record uses exactly these fields, in this order:

```
### <kebab-case-slug>

Type: safety | liveness | reachability
Reachability: default-production | explicit-config-only | test-only
Status: active | invalidated
Exercised: not yet — <what is missing> | partial — <what is covered> | yes — <what constructed it>
Guarantee: <one sentence>
Check: `<semantics>` — <the exact condition to assert, plus why these semantics>
Fault/timing angle: <the window, the interleaving, or "none">
Required faults and enabling state: <concretely what must occur>
Confidence: high | medium | low — [evidence](evidence/<slug>.md). <what you verified and how>
Existing check: <location + what it covers, or "none">
Impact: <consequence if it fails>
Open questions:
- <question> (append "(needs human input)" for a design decision)
```

`Open questions: None.` is valid and preferred over an empty list.

## Check semantics

Choose from exactly these five, and record the rationale in the `Check:` line.

| The property says | Semantics |
| --- | --- |
| this must hold whenever evaluated | `always` |
| an optional path may never run, but must be safe when it does | `always-or-unreached` |
| a meaningful state must occur at least once per campaign | `sometimes` |
| a specific code point or path should be executed | `reachable` |
| a forbidden code point must never be entered | `unreachable` |

Two rules that are violated most often:

- A forbidden **state** with no dedicated detection point uses `always(!X)`, never
  `unreachable`. `unreachable` is only for a code location that must not execute.
- `reachable` is location coverage. `sometimes` is situation coverage. A campaign
  can execute a branch's lines while never producing the operational state the
  branch represents; when that distinction matters, the answer is `sometimes`.

## Coverage-check rules

A coverage check asserts the independent **preconditions** that jointly create a
vulnerable window, so it still fires on a correct implementation.

- Never assert the violation itself.
- Never pair `always(!X)` with `sometimes(X)`; that marker can only fire by
  observing the defect. Assert the independent preconditions instead.
- Marker names are constant and globally unique. Never construct them
  dynamically.

## Liveness rules

- A liveness check needs a **bounded** fault-free window: run under load, stop the
  pressure, poll until stable within an explicit bound, then check.
- Never write an unbounded "eventually". A finite test cannot refute it, and a
  generous timeout cannot distinguish one recovery pass from a thousand.
- State the bound in the units the code actually bounds: attempts, deadlines, or
  an explicit interval.

## Effect accounting under loss

When counting effects on a path where a response or a message can be lost, track
**attempted** and **acknowledged** separately and state bounds: observed effects at
least the acknowledged count, at most the attempted count. Aggregate totals can
cancel inside a one-to-one contract, so per-identity checks are the primary oracle
and the bounds are a cheap screen.

## Evidence file structure

One file per record at `evidence/<slug>.md`:

```
# <slug>

## Discovery trigger
## Evidence trail
## Failure scenario
## Timing windows and dependencies
## What a test must construct
## Investigation log
### Q: <open question>
- Sources examined:
- Findings:
- Missing evidence:
- Conclusion: <resolved with answer | unresolved, needs X | needs human input>
```

Target 60 to 120 lines. Exceeding it to keep verified evidence is correct; say so
in your report rather than deleting evidence to hit a number.

## Per-part artifacts

Each part directory contains:

| File | Contents |
| --- | --- |
| `catalog.md` | Scope, reachability classes, index table, the records, relationship map |
| `existing-checks.md` | Every existing claim-bearing check, with per-check status `unaudited`, plus explicit "none found" for empty categories, plus suspiciously quiet areas |
| `fault-map.md` | Fault classes with availability, per-property required faults, coverage checks to add, leverage ranking by cheapest valid oracle |
| `portfolio-evaluation.md` | Independent evaluation, finding disposition, gaps queued, biases for a human |
| `evidence/<slug>.md` | One per record |

An existing check never removes a property from the catalog. Catalog the property,
link the check, and mark its status `unaudited`. Adequacy verdicts belong to
`/testing:invariant-test-review` for tests and
`/low-level-systems:defensive-assertions-and-invariant-guards` for production
guards.

## Pipeline

1. **Scope survey.** Module sizes, test inventory, docs, assertion density.
2. **Lens passes**, in parallel, one attention focus each; wildcard runs last and
   deliberately hunts outside the others' territory. Each writes its findings to
   `_lenses/<lens>.md` in the part directory and returns a short summary only.
3. **Synthesis.** One agent reads the lens files and writes `catalog.md`,
   `existing-checks.md`, and `fault-map.md`.
4. **Evidence.** Agents write `evidence/<slug>.md` per record.
5. **Evaluation.** A fresh-context agent that has not seen the discovery reasoning
   evaluates the portfolio through four lenses: harness fit, coverage balance,
   implementability, wildcard. It classifies every finding as gap, refinement, or
   bias.
6. **Disposition.** Refinements applied, gaps queued, biases surfaced to a human.
7. **Verification.** Mechanical: records equal index rows equal evidence files, all
   links resolve, no schema gaps, semantics distribution recorded.

`_lenses/` is working material, not a deliverable. It stays for traceability.
