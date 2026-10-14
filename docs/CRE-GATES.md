# CRE access and execution gates

Checked against official documentation on 13 October 2026. Public application CI and local acceptance are separate from CRE execution.

| Layer | Actual state |
| --- | --- |
| Fixture | Local synthetic demonstration |
| GitHub adapter | Real anonymous GET acquisition supported; each delivery needs its own current evidence |
| CRE SDK source | Previously typechecked and bundled with SDK 1.23.0 |
| CRE WASM | Previously compiled locally with verified official Javy v8.1.0 |
| CRE CLI simulation | **Not executed** |
| DON/report | **Not deployed or executed; no verified signature** |
| Consumer contract / wallet decision | Local role/state model only |

## Smallest conditions for further execution

1. A real CI delivery needs a buyer-reviewed workflow, complete fixed repository/commit/run/attempt/workflow/blob coordinates and successful mandatory checks inside the frozen time window.
2. Authenticated CRE simulation needs a verified CLI and an existing CRE account/organization login. The official simulation prerequisites include authentication. This HTTP-only source has no secret, RPC, wallet or broadcast. Replace the synthetic example config with a real fresh frozen request. CLI YAML has not yet been validated by a CLI run.
3. DON deployment needs organization deploy approval. The official docs describe private registry operations managed by CRE login; this path has not been configured here. Execution quota/cost and sponsor acceptance must be resolved before activation.
4. Trustworthy report consumption needs independent signed-report verification, workflow/owner/execution/domain bindings, policy/commit/request expiry and atomic replay protection. The current `verifiedDON: false` result cannot be trusted as a DON attestation or imported by the server.

Possible later command, **not executed**:

```sh
cre workflow simulate ./cre --target staging-settings --non-interactive --trigger-index 0
```

The official Chainlink event bounty asks for a meaningful actual CRE/Functions/Data Feeds/CCIP role. Whether simulation suffices remains unclear. Compiled source alone does not establish eligibility. Functions is not a fallback: official documentation lists deprecation on 15 June 2026 testnet and 30 June 2026 mainnet.

## Official sources

- [Simulation prerequisites and limits](https://docs.chain.link/cre/guides/operations/simulating-workflows)
- [Deploy access approval](https://docs.chain.link/cre/account/deploy-access)
- [Registry and deployment requirements](https://docs.chain.link/cre/guides/operations/deploying-workflows)
- [CLI installation and integrity checks](https://docs.chain.link/cre/getting-started/cli-installation/macos-linux)
- [TypeScript HTTP guide](https://docs.chain.link/cre/guides/workflow/using-http-client/get-request-ts)
- [Identical consensus](https://docs.chain.link/cre/reference/sdk/consensus-ts)
- [Functions deprecation](https://docs.chain.link/chainlink-functions)
- [ETH Shenzhen 2026 event](https://hackathon.xyz/events/public/c3b55fc8-f30a-4291-b7e3-ca32830b938d)
