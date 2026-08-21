# wire

Wire-format conformance. Not a deployable worker.

```bash
npm run test:wire   # 45 assertions
```

`devkit/host.mjs` reimplements the SDK's msgpack encoding in JavaScript, because the
SDK's codec is AssemblyScript and cannot be imported into Node. If the SDK changes its encoding, the
devkit keeps passing its own tests while diverging from the runtime.

This harness compiles the SDK's **own** `MsgpackWriter` and `MsgpackReader` and exposes
them over a byte ABI, so `check.mjs` can assert both directions against them:

- **SDK writes → devkit reads.** Request meta, response meta, pair arrays, fetch
  responses with and without an error.
- **devkit writes → SDK reads.** The same shapes, including the exact `FetchReq` the
  devkit builds for `env.fetch`.
- **Byte-for-byte equality** on encodings both sides produce.

Cases sit on every prefix boundary the format has: fixstr/str8/str16 at 31 and 255
bytes, fixarray/array16 at 15 elements, single-byte and `0xcd` uint16 at 127. Multi-byte
UTF-8 is covered in both directions, since msgpack lengths are byte counts and a
char-count bug would only show up there.

The SDK ships no ABI or protocol version constant, so there is nothing to assert a
version against. `@automattic/vip-edge-workers-sdk` is therefore pinned to an exact
version in `package.json` rather than a caret range, so an upgrade runs this suite.
