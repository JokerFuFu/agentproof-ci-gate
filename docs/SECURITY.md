# Security boundary — local prototype

## What is established

The evaluator compares the exact frozen delivery and acceptance coordinates against data obtained by a known adapter. Successful evidence is scoped to one repository/run/attempt, one request and its policy hash. Mandatory checks must complete successfully within the time window. A second run read detects changes during acquisition. The ledger persists successful-use claims and blocks reuse by other requests.

The gate owns provenance. The browser cannot supply snapshots, verdicts or DON labels. A fixture is synthetic; the REST adapter is a single local process making public GitHub GETs. CRE source uses SDK HTTP and identical consensus, but its source, typecheck and compiled WASM are not proof of execution. No DON report is imported or trusted.

Human acceptance is an independent transition. The submitter cannot accept in the modeled role interface. The buyer may reject even without CI success. Cancel/expiry invalidates the in-flight operation token. After a restart, interrupted acquisitions are blocked until explicitly retried. The decision's own timestamp is checked against freshness and the request deadline.

## Local trust and operational limits

- `local-buyer` and `local-agent` are modeled roles, not authenticated people or wallet addresses. Anyone controlling this loopback UI/process can act as those local roles. There is no cryptographic human signature, onchain receipt or finality.
- Filesystem owners can rewrite policy hashes, snapshots and the replay database. A hash checks content association, not the integrity of the local operator. Exported JSON is data, not an independently authoritative proof.
- Replay protection is scoped to this preserved local database. Copying an export or deleting the database cannot carry global uniqueness into another installation.
- Acceptance reevaluates **stored** evidence freshness, without a fresh external GET at the decision. A GitHub rerun, deletion or cancellation after sampling can be unseen within the TTL. Accepted status is a historical local decision, not an assertion that CI evidence remains fresh forever.
- The repository name and numeric ID are both required. Fork head repositories are rejected. Only `push` and `workflow_dispatch` are supported; pull request merge commits and reusable workflow provenance are not generalized in this version.
- API data is bounded to 2 MiB per endpoint, a 15-second overall local acquisition timeout, and at most 100 jobs. Partial pagination fails closed. HTTP-only CRE code makes six GETs; operational quotas and actual capability timing remain unverified without simulation.
- Up to 25 mandatory jobs and 25 steps per job can be frozen. Duplicate mandatory names are rejected. A job's success cannot mask failure in a required step. Optional/unlisted steps are outside the policy.
- Clocks allow up to 30 seconds of remote timestamp skew. The local system clock is trusted, with no independent time attestation.

## Workflow and test adequacy

The workflow blob must be reviewed by the buyer at the target commit. This is a Git blob SHA, not an oracle signature. The policy does not prove that the workflow checked out the correct code, ran adequate tests, avoided malicious scripts, used pinned dependencies/actions or tested reusable workflow implementations. Those must be inspected by the buyer and secured in the policy/workflow design. A successful CI run may test trivial or irrelevant assertions. Passing this gate does not establish absolute code security, correct AI behavior, usefulness or independent identity.

## Storage and HTTP failures

State writes use temporary files, fsync, atomic rename and directory fsync. Any save failure quarantines further mutations, because an error after rename can leave the disk committed while memory is older. Read views withdraw the ready gate; restart reads the actual disk state. Malformed JSON state is not silently replaced. Listener startup failures release the process lock. Forced process termination can leave a lock; verify its PID is stopped before manual removal, preserving the state file.

The server binds `127.0.0.1`, checks the Host and Origin, requires JSON and a custom client header for mutations, denies CORS, limits request bodies, serves only explicitly mapped static files, and sets a restrictive CSP. These checks prevent ordinary cross-origin browser requests; they do not authenticate local processes. Source data is escaped in the UI. Network loss disables actions in the UI until current server state is read again.

## Still needed before production or external attestation

Authenticated buyer identity; authenticated and signed CRE report verification with workflow/owner/execution/domain bindings; atomic report consumption and durable global nonce/replay rules; fresh acquisition or an explicit accepted snapshot policy; reviewed consumer contract/state semantics; deployment/upgrade/access control review; provider and transitive workflow dependency controls; service monitoring; and independent security review. None is claimed complete here. No payment or automatic fund release is implemented.
