# crypto

Host-executed cryptography: HMAC webhook verification and HS256 JWT.

```bash
node scripts/build.mjs crypto && node examples/crypto/check.mjs   # 15 assertions
```

No hash or HMAC code lives in the wasm — `crypto.sha256`, `crypto.hmac_sha256`,
`crypto.constant_time_eq` and `crypto.jwt_verify_hs256` are all host calls, so the binary
stays small.

| Route | Shows |
|---|---|
| `POST /webhook` | GitHub-style `x-hub-signature-256` check with `hmacSha256Str` + `secureCompare` |
| `POST /private` | `jwtVerifyHs256`, forwarding claims to origin as a header |
| `POST /digest` | `sha256` on its own |

`check.mjs` verifies every digest against `node:crypto`, and covers expired tokens, wrong
secrets, non-HS256 algorithms and malformed input.

The devkit backs these host calls with a pure-JS SHA-256 in
[`devkit/crypto.mjs`](../../devkit/crypto.mjs), not WebCrypto: WebCrypto is async-only
and cannot implement a synchronous host call. Digests are verified against `node:crypto`
across block-boundary lengths.

Secrets come from `getenv`, so they are injected at deploy time rather than compiled in.
