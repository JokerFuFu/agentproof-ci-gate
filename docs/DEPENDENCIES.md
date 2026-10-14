# Dependency and tool notices

The root application has **no npm dependencies** and uses Node built-ins. Application CI uses official GitHub actions at reviewed release commits:

| Action | Release | Pinned commit |
| --- | --- | --- |
| `actions/checkout` | v7.0.1 | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| `actions/setup-node` | v7.1.0 | `949feb2413d6458794dcd2491c4babbbce0c15c1` |

Both actions retain their upstream MIT licenses. They are downloaded by GitHub's runner rather than copied into this repository. Node 26.8.2 is listed in the official [node-versions manifest](https://github.com/actions/node-versions/blob/main/versions-manifest.json).

The separate CRE development tree records all dependency versions and integrity hashes in `cre/package-lock.json`. Dependencies, compiled SDK bundles, Javy binaries and WASM artifacts are excluded from source publication.

| Direct dependency or build tool | Version | Upstream license |
| --- | --- | --- |
| `@chainlink/cre-sdk` | 1.23.0 | BUSL-1.1 |
| `@chainlink/cre-sdk-javy-plugin` (transitive) | 1.7.0 | BUSL-1.1 |
| `@noble/hashes` | 2.2.0 | MIT |
| `zod` | 3.25.76 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| Javy | v8.1.0 | Apache-2.0 with LLVM exception |

The SDK's installed `LICENSE.md` identifies SmartContract Chainlink Limited SEZC as licensor and a change date of 20 May 2029. Its current Business Source License is retained; it is not represented as a permissive open-source dependency. This candidate's use is local development/testing, with no production deployment. The installed dependency distributions and upstream [CRE SDK repository](https://github.com/smartcontractkit/cre-sdk-typescript) remain the authoritative source for license text and applicable conditions.

Other transitive packages keep their own licenses as recorded in the lockfile/distributions. There is no project-wide reuse license selected for the original candidate source. This notice does not relicense any third-party work.
