# Working in this repo

A MonetizationOS proxy as a WordPress VIP edge worker (`assembly/`), and the local host it
is tested on (`devkit/`). [`README.md`](README.md) has the layout and the commands.

Before opening a PR, run the gate from a clean `build/`:

```bash
npm run test:all && npm run test:artifacts && npm run test:conformance
```

`test:live` needs Chrome and a stand-in org; run it when the playground or live mode changes.

## Where the ground truth is

Ask in this order. Each level answers a different kind of question.

1. **The SDK source**, for what a worker can call and how the ABI is encoded. It is in
   `node_modules/@automattic/vip-edge-workers-sdk/assembly/`, and upstream at
   <https://github.com/Automattic/vip-edge-workers-sdk>. That repo is the guest half only:
   no host, no tests, no conformance suite. Its commit history is how SDK changes get
   traced (the body-marker renames in 0.7.0 and 0.7.1 are in it), and its `examples/` show
   idiomatic use.
2. **[`DIVERGENCES.md`](DIVERGENCES.md)**, for how this worker differs from core
   `@monetizationos/proxy` and why. Comments and tests that describe a divergence carry its
   ID. IDs are never reused.
3. **[`tools/conformance/`](tools/conformance)**, for what the real VIP host does. The
   runtime is a separate codebase and is not vendored here; where the notes cite
   `edge-workers <sha>`, that is it. Its README lists what has been observed. Anything
   not listed is unknown until the probe worker is deployed and curled.
4. **The devkit** is none of the above. It is our reading of 1, checked against the SDK's
   own codec by `test/wire`. If it disagrees with a deploy, the devkit is wrong.

## Conventions

- `@automattic/vip-edge-workers-sdk` is pinned to an exact version: there is no ABI version
  constant to check against, so a bump is deliberate and has to pass `npm run test:wire`.
  `html-rewriter-wasm` is pinned for the same reason.
- When the SDK or host changes behaviour, update the devkit, the probe in
  `tools/conformance`, and the notes there together.

## AssemblyScript traps

**AssemblyScript is not TypeScript.** No closures, no `try`/`catch` (a throw aborts), no
`Promise`, no union types, no spread, no `for…of`, no `Record<string, unknown>`. Fail-open
error handling has to be rebuilt as checked returns.

**`JSON.Obj.getAs<T>()` in json-as only works for `JSON.Obj` and `string`.** Arrays and
`Map` abort with a holey-array error; `getAs<i32>` silently returns `0`. To read a mixed
object, parse it twice — as `JSON.Obj` for key presence, as a typed class for values.
`assembly/behavior.ts` does this, because it needs to distinguish an absent
key from a null one.
