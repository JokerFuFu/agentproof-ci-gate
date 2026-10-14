# AgentProof CI Gate

Bind an AI code delivery to one GitHub commit and a frozen buyer acceptance policy. Read the exact CI run and required checks before opening a separate human acceptance decision. Passing CI is a prerequisite; it does not prove absolute code security or accept the delivery automatically.

This is an independent **ETH Shenzhen 2026 candidate**, developed on **13–14 October 2026**. The earlier [AgentProof Monad](https://github.com/JokerFuFu/agentproof-monad/tree/7a1a48e) supplies historical context only. Its code, artwork, chain receipts and previous submission are not incorporated or presented as new work. See [provenance](docs/PROVENANCE.md).

## Run locally

The application has no npm dependencies. Node 26.8.2 is the tested version; the declared minimum is Node 22.13. The Chinese UI is a local review bench with an original illustrated code courier, evidence dossiers and a separate manual decision.

```sh
git clone https://github.com/JokerFuFu/agentproof-ci-gate.git
cd agentproof-ci-gate
npm --userconfig=/dev/null test
npm --userconfig=/dev/null run check
npm start
```

Open <http://127.0.0.1:5213/>. The server binds loopback only. Set `AGENTPROOF_GATE_PORT` or `AGENTPROOF_GATE_STATE_DIR` to use a different port or preserved local database.

1. Choose **Fixture** and a scenario; review and freeze the policy.
2. Read the evidence. Inspect repository/commit/workflow bindings, individual checks and rejection reasons.
3. A pass opens **waiting for human review**. Review the actual delivery and decide separately using the modeled local buyer role.
4. Copy the same run into another request to demonstrate replay protection. Other fixture scenarios cover failure, old commits, expiry, interruption and cancellation.

Fixture coordinates and responses are synthetic. They are not a GitHub run, CRE simulation or DON execution. Source labels are retained in the UI and exports.

## Frozen policy and external evidence

The immutable policy includes repository name and numeric ID, full 40-character commit SHA, run ID/attempt, workflow ID/path and Git blob SHA, branch/event, exact mandatory job/step names, earliest run time, evidence maximum age and request deadline. A domain-separated SHA-256 identifies the normalized policy.

The public GitHub adapter makes six anonymous, bounded GETs: repository, run, workflow, workflow file at the fixed commit, jobs for the exact attempt, and a confirming run read. It checks the head repository, completeness, successful mandatory checks and real ordered timestamps. Required names must match exactly once. More than 100 returned jobs fails closed.

Failures, changed commits/workflows, fork heads, missing/ambiguous/skipped/failed checks, changed runs, stale evidence and replay keep acceptance closed. Successful evidence consumes repository/run/attempt in the preserved local ledger, even if later canceled, rejected or expired. Interrupted acquisition becomes blocked after restart; late results cannot reopen a canceled request. The buyer decision reevaluates stored evidence freshness at its own timestamp.

Public metadata discovery:

```sh
npm run probe:github -- owner/repository
npm run probe:github -- owner/repository 123456789
```

The probe does not issue a CI verdict. Review the actual workflow source before choosing its job/step names. In the **Public GitHub** UI, supply the complete real policy JSON; the initial JSON template is synthetic.

HTTP receipts retain only safe allowlisted headers and bounded diagnostics. The shared reader honors rate-limit reset/Retry-After pauses, including quota exhaustion after a successful GET. It does not automatically retry or switch identities.

## Application CI

[`acceptance.yml`](.github/workflows/acceptance.yml) runs on `main` pushes and manual dispatch. Both jobs check out and assert the exact triggering commit, use Node **26.8.2**, and use official actions pinned to complete commit SHAs. Permissions are `contents: read`; credentials are not persisted. There are no custom secrets, deployments, paid runners or dependency installation in these application jobs.

| Required job | Exact required step names |
| --- | --- |
| `application-tests` | `Checkout application source`; `Prepare Node for application tests`; `Verify application commit`; `Run application tests` |
| `source-checks` | `Checkout source checks`; `Prepare Node for syntax checks`; `Verify syntax commit`; `Run syntax checks` |

The first public Actions run must be inspected through its terminal status and full job logs before treating it as real evidence. Workflow source alone is not an execution receipt. See [Actions](https://github.com/JokerFuFu/agentproof-ci-gate/actions) and [verification scope](docs/VALIDATION.md).

## CRE execution status

[`cre/main.ts`](cre/main.ts) uses the real Chainlink CRE SDK HTTP capability, runtime time and identical consensus. [`cre/acquisition.ts`](cre/acquisition.ts) validates the frozen policy hash and reuses the pure evaluator. This is intended as the external evidence orchestration layer.

**Compiled source only: CRE CLI simulation has not run; no DON deployment, signed oracle report, consumer contract or chain transaction exists.** The local server cannot import a CRE report. `verifiedDON: false` must never be promoted by trusting JSON.

The separate development tree pins SDK **1.23.0**, plugin **1.7.0**, and TypeScript **5.9.3** in its lockfile. It is not installed or run by application CI. Existing local seam tests (5 cases), typechecking and JS/WASM compilation were previously successful; these are not runtime/DON verification.

```sh
cd cre
npm ci --ignore-scripts --no-audit --no-fund --userconfig=/dev/null
npm run typecheck
npm test
npm run build:js
cd ..
node scripts/build-wasm.mjs
```

JS compilation requires Bun 1.2.21 or newer. The WASM script downloads official Javy v8.1.0, verifies its archive checksum and writes project-local artifacts. The example CRE config is synthetic and stale; replace it with a real fresh frozen request before an authorized simulation. See [CRE access gates](docs/CRE-GATES.md) and [dependency notices](docs/DEPENDENCIES.md).

## Security and operational limits

This is a tested local prototype, not a complete security audit. `local-buyer` and `local-agent` model roles; they are not authenticated customers or wallet signatures. A filesystem owner can alter state. Exports are local records rather than independently authoritative proofs.

The decision uses stored evidence; changes to GitHub after sampling can be unseen within its freshness window. Pinning one workflow blob does not pin all transitive dependencies or prove test adequacy. Passing CI does not guarantee code safety, utility or correct AI behavior.

State lives under `.local/gate/`. Atomic writes, a process lock, replay preservation and storage-error quarantine protect normal local operations. If a forced shutdown leaves `gate.lock`, verify the recorded process is stopped before removing that lock. Preserve `state.json`; deleting it defeats this installation's replay history. See [security boundaries](docs/SECURITY.md).

## Next execution gates

Authenticated CRE simulation requires a verified CLI and an existing CRE account login. DON deployment requires approval. Signed-report consumption and authenticated human acceptance still need implementation and review. These are separate from real GitHub CI and local fixture execution. No Functions fallback is planned.

This repository is a candidate, not a contest submission. No sponsor eligibility or award is claimed; simulation eligibility remains unresolved. No public website, payment, funds release or chain deployment is part of this version.

No project-wide reuse license has been selected. Dependencies retain their own licenses; no dependency implementation or compiler binary is vendored here.
