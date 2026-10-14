# First real GitHub CI and local demo decision

This is a historical record for the exact commit below. Later commits/runs require their own fresh frozen request. These records are neither a CRE execution nor authenticated customer acceptance.

## Real remote execution

| Coordinate | Actual value |
| --- | --- |
| Repository | `JokerFuFu/agentproof-ci-gate` |
| Repository ID | `1418309230` |
| Commit | `aac55fd3bce8da876deae812742510d94f71e2a8` |
| Run / attempt | `38506483195` / `1` |
| Workflow ID | `383903362` |
| Workflow path | `.github/workflows/acceptance.yml` |
| Workflow Git blob SHA | `9207519d32b85ca571a8cd80c688f3b8435ab66f` |
| Branch / event | `main` / `push` |
| Terminal result | `completed` / `success`, updated 14 October 2026 03:29:23 UTC |

[Actual GitHub Actions run and job logs](https://github.com/JokerFuFu/agentproof-ci-gate/actions/runs/38506483195). The full logs contain **149 tests, 149 passed, 0 failed/canceled/skipped**, and **23 modules syntax checked**. Both jobs assert the exact checkout commit. Each of the eight required steps matched once and completed successfully. The tests themselves exercise synthetic boundary inputs and local HTTP listeners; the runner execution is real.

## Local gate and separate decision

The normal policy draft used the real system time **03:32:53.220 UTC**, a rolling 900-second earliest-run window, maximum evidence age **900 seconds**, and request TTL **3600 seconds**. CI timestamps were not altered. The UI separately reviewed and froze that policy at **03:34:04.155 UTC**.

| Local record | Value |
| --- | --- |
| Request | `87ab7f5c-aae5-47be-8039-46ee51bf6e12` |
| Policy SHA-256 | `58ca7aea81b4b261c7e8fe9c358c4494faeec0fdb8305fb340549d539b2880c0` |
| Acquisition | Six real anonymous `api.github.com` GETs, all HTTP 200, 03:34:04–03:34:07 UTC |
| Gate | Passed exact bindings, 2 required jobs / 8 required steps and time checks; entered `awaiting_review` |
| Separate decision | `local-buyer` accepted at 03:35:05.518 UTC using the local review checklist |

No CI success automatically accepted the request. The role is an explicitly **local demo identity**, with no customer authentication, wallet signature, oracle signature or chain finality. The exported JSON is a local prototype record. Prior reference records and replay history were preserved.

Actual browser captures verified the separate review UI, HTTP receipts and a 390-pixel mobile layout without horizontal overflow or page errors. Screenshots and raw acquisition/log files are retained as local verification artifacts rather than exposing internal paths or local database files in this repository.

CRE remained **compiled-only**, simulation **not run**, DON **not deployed**. This result does not establish absolute code security, full audit coverage, sponsor eligibility or a contest award.
