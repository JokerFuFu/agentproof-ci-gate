# Verification scope

The core boundary suite covers exact repository/head/commit/run/attempt/workflow/blob binding, successful required checks, unique step names, stale/future timestamps, request expiry, replay, acquisition failure, interruption/restart, cancellation races, storage quarantine and loopback HTTP controls. UI model tests cover review detail, recovery guidance and stale client responses.

On **14 October 2026**, the privacy-filtered publication tree passed **149/149 core tests** (0 failed, canceled or skipped), exit 0, and syntax checks for **23 JavaScript modules**, exit 0, on Node 26.8.2. The first actual Actions run also completed successfully with the same unskipped suite and syntax count; both full job logs were inspected and retained outside the public tree. See the [fixed historical demo coordinates](LIVE-CI-DEMO.md).

The separate CRE seam previously passed 5 fixture-based tests, typechecking and JS/WASM compilation. Application CI does not execute CRE simulation or DON. Fixture unit tests are synthetic; remote Actions proves execution of this application's test commands, not independent code security.

For a real gate demonstration, freeze actual own-repository coordinates and a current policy window, acquire all six real public endpoints, inspect the gate result, and make a separately labeled local demo buyer decision. Preserve the original external-reference records and replay history.

This is a bounded prototype verification, not a full audit or authenticated customer acceptance.
