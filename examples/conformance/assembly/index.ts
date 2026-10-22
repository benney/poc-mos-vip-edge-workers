// Host conformance probe.
//
// The devkit's host is written from the SDK's source and README, so its behaviour is a
// reading of the contract, not the contract itself. Deploy this worker to a real VIP
// environment and each probe route reports what the host actually does. Compare the
// output with `check.mjs`, which asserts the same probes against the devkit — any
// difference is a devkit bug or an undocumented host behaviour.
//
// Probes are separate routes on purpose: AssemblyScript has no try/catch, so anything
// that might throw has to be isolated to one request.
import {
  fetch, getenv, getRandomValues, hexEncode, HtmlRules, KV, onClientRequest, onClientResponse,
  onOriginResponse, RegExp, Request, Response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

export {
  alloc,
  on_client_request,
  on_client_response,
  on_origin_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

const PROBE = "/__probe/";
const MARK = "x-probe-mark";

function line(name: string, value: string): string {
  return name + "=" + value + "\n";
}

function reportMemory(req: Request, bytes: i32): void {
  const memory = new Uint8Array(bytes);
  memory[0] = 0xa5;
  let offset: i32 = 65536;
  while (offset < bytes) {
    memory[offset] = 0x3c;
    offset += 65536;
  }
  memory[bytes - 1] = 0x5a;
  req.respondText(200, line("bytes", bytes.toString()) + line("status", "allocated"));
}

onClientRequest((req: Request): void => {
  if (!req.url.startsWith(PROBE)) return;
  const probe = req.url.slice(PROBE.length);

  if (probe == "memory-256k") { reportMemory(req, 256 * 1024); return; }
  if (probe == "memory-512k") { reportMemory(req, 512 * 1024); return; }
  if (probe == "memory-1m") { reportMemory(req, 1024 * 1024); return; }
  if (probe == "memory-2m") { reportMemory(req, 2 * 1024 * 1024); return; }
  if (probe == "memory-4m") { reportMemory(req, 4 * 1024 * 1024); return; }
  if (probe == "memory-8m") { reportMemory(req, 8 * 1024 * 1024); return; }

  // Does a request-phase mutation reach the response-phase snapshot? The whole
  // decide-then-rewrite pattern depends on this being visible in onOriginResponse
  // and absent in onClientResponse.
  if (probe.startsWith("snapshot")) {
    req.headers.set(MARK, "set-in-client-request");
    return; // fall through to origin; the response phases report what they saw
  }

  // fetch() is allowed in every phase since SDK main 2026-10-13. These three probes
  // confirm the host agrees in each phase the MOS workers use.
  if (probe.startsWith("fetch-client-phase")) {
    const target = getenv("PROBE_FETCH_URL");
    const resp = fetch(target === null ? "https://example.com/" : target);
    req.respondText(200,
      line("phase", "client-request")
      + line("isError", resp.isError() ? "true" : "false")
      + line("errorKind", resp.errorKind === null ? "(null)" : resp.errorKind!)
      + line("status", resp.status.toString()));
    return;
  }

  // Documented: rules registered in a request phase are silently dropped.
  if (probe.startsWith("rules-in-request-phase")) {
    new HtmlRules().appendInside("body", "<!--REQUEST-PHASE-RULE-->").install();
    return; // if the marker appears in the page, the host applied it after all
  }

  // SDK 0.6 runs RegExp on the host's Rust regex. The devkit stands in with JS RegExp,
  // so these lines are the ones to diff against a deploy.
  if (probe.startsWith("regex")) {
    const post = new RegExp("^/(?<year>\\d{4})/(?<slug>[a-z0-9-]+)/?$", "i");
    const m = post.exec("/2026/Tide-Tables/");
    const words = new RegExp("\\b(\\w)(\\w*)", "g");
    req.respondText(200,
      line("exec.slug", m === null ? "(no match)" : m.group("slug")!)
      + line("exec.year.index", m === null ? "-" : m.start(1).toString())
      + line("test.unicode", new RegExp("^\\p{L}+$").test("Tōkyō") ? "true" : "false")
      + line("replace.template", words.replace("tide tables", "$2$1"))
      + line("replace.first", new RegExp("a").replace("banana", "[$&]"))
      + line("split", new RegExp(",\\s*").split("a, b,c").join("|"))
      + line("multibyte.index", new RegExp("b").search("ééb").toString()));
    return;
  }

  if (probe.startsWith("random")) {
    const bytes = getRandomValues(new Uint8Array(16));
    req.respondText(200, line("bytes", hexEncode(bytes).length.toString()) + line("value", hexEncode(bytes)));
    return;
  }

  if (probe.startsWith("kv")) {
    KV.setText("probe-key", "stored");
    const readBack = KV.getText("probe-key");
    const counter = KV.incr("probe-counter");
    req.respondText(200,
      line("kv.setText+getText", readBack === null ? "(null)" : readBack!)
      + line("kv.incr", counter.toString()));
    return;
  }

  // One selector per request: an unsupported selector throws from install(), which
  // aborts, so the failure mode is this request only.
  if (probe.startsWith("selector")) {
    const sel = getenv("PROBE_SELECTOR");
    if (sel === null) { req.respondText(400, "set PROBE_SELECTOR"); return; }
    return; // installed in onOriginResponse, where rules are effective
  }

  // Must reach origin (or the cache) so the response phases can run their half of the probe.
  if (probe.startsWith("fetch-origin-phase")) return;
  if (probe.startsWith("fetch-client-response-phase")) return;
  if (probe.startsWith("set-body-client-response")) return;

  if (probe.startsWith("body-marker")) {
    const body = req.text();
    req.respondText(200, line("client_request_body_exported", "false")
      + line("req.body", body === null ? "(null)" : "present:" + body.length.toString()));
    return;
  }

  req.respondText(200,
    "VIP edge worker conformance probe\n\n"
    + "/__probe/snapshot                cross-phase request snapshot visibility\n"
    + "/__probe/fetch-client-phase      fetch() in the allowed phase\n"
    + "/__probe/fetch-origin-phase      fetch() in onOriginResponse\n"
    + "/__probe/fetch-client-response-phase  fetch() in onClientResponse\n"
    + "/__probe/set-body-client-response setBodyText in onClientResponse without the body marker\n"
    + "/__probe/rules-in-request-phase  are request-phase rules dropped?\n"
    + "/__probe/selector                install PROBE_SELECTOR (one per request)\n"
    + "/__probe/regex                   RegExp on the host's regex engine\n"
    + "/__probe/random                  getRandomValues\n"
    + "/__probe/kv                      KV bytes + counter round-trip\n"
    + "/__probe/body-marker             is req.body populated without the marker?\n"
    + "/__probe/memory-{256k..8m}       can the worker allocate and touch this size?\n");
});

onOriginResponse((resp: Response): void => {
  const req = resp.request;
  if (!req.url.startsWith(PROBE)) return;
  const probe = req.url.slice(PROBE.length);

  if (probe.startsWith("snapshot")) {
    const seen = req.headers.get(MARK);
    resp.headers.set("x-probe-origin-phase-sees-mark", seen === null ? "no" : "yes");
    resp.headers.set("x-probe-origin-phase-url", req.url);
    resp.headers.set("x-probe-origin-phase-method", req.method);
    return;
  }

  if (probe.startsWith("fetch-origin-phase")) {
    const target = getenv("PROBE_FETCH_URL");
    const out = fetch(target === null ? "https://example.com/" : target);
    resp.headers.set("x-probe-origin-fetch-iserror", out.isError() ? "true" : "false");
    resp.headers.set("x-probe-origin-fetch-errorkind", out.errorKind === null ? "(null)" : out.errorKind!);
    return;
  }

  if (probe.startsWith("selector")) {
    const sel = getenv("PROBE_SELECTOR");
    if (sel === null) return;
    // Throws host-side if the selector is outside lol-html's subset.
    new HtmlRules().setAttr(sel, "data-probe", "matched").install();
    resp.headers.set("x-probe-selector-installed", sel);
  }
});

onClientResponse((resp: Response): void => {
  const req = resp.request;
  if (!req.url.startsWith(PROBE)) return;
  const probe = req.url.slice(PROBE.length);

  if (probe.startsWith("fetch-client-response-phase")) {
    const target = getenv("PROBE_FETCH_URL");
    const out = fetch(target === null ? "https://example.com/" : target);
    resp.headers.set("x-probe-client-response-fetch-iserror", out.isError() ? "true" : "false");
    resp.headers.set("x-probe-client-response-fetch-errorkind", out.errorKind === null ? "(null)" : out.errorKind!);
    resp.headers.set("x-probe-client-response-fetch-status", out.status.toString());
    return;
  }

  // A worker replaces the page this way when MOS returns a body. The runtime's body
  // marker is not exported here, so this asks whether the host honours it anyway.
  if (probe.startsWith("set-body-client-response")) {
    resp.setBodyText("PROBE-REPLACED-BODY");
    return;
  }

  if (!probe.startsWith("snapshot")) return;

  // Documented: this snapshot predates request-phase mutations, so the mark
  // should NOT be visible here.
  const seen = req.headers.get(MARK);
  resp.headers.set("x-probe-client-phase-sees-mark", seen === null ? "no" : "yes");
});
