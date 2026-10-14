// SDK's JS wrapper/type/runtime compatibility checks, without its home-directory Javy installer.
import { main as compileToJs } from './node_modules/@chainlink/cre-sdk/scripts/src/compile-to-js';
await compileToJs('./main.ts', './artifacts/ci-gate.js');
