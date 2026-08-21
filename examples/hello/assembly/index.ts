// Minimal worker: the smallest thing that exercises both phases and the HTML rewriter.
//
// onClientRequest stamps a header and can short-circuit; onOriginResponse tags the
// response and injects a banner into the page. No fetch(), no JSON, no config — see
// mos-proxy for a worker that uses all of it.
import { HtmlRules, onClientRequest, onOriginResponse, Request, Response } from "@automattic/vip-edge-workers-sdk/assembly/index";

export {
  alloc,
  on_client_request,
  on_origin_response,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

onClientRequest((req: Request): void => {
  if (req.url == "/edge-ping") {
    req.respondText(200, "pong");
    return;
  }
  // Request mutations are marshaled forward, and readable in onOriginResponse
  // via resp.request — the only channel between the phases.
  req.headers.set("x-hello-worker", "1");
});

onOriginResponse((resp: Response): void => {
  const contentType = resp.headers.get("content-type");
  if (contentType === null || !contentType.toLowerCase().startsWith("text/html")) return;

  const seen = resp.request.headers.get("x-hello-worker");
  resp.headers.set("x-hello-worker-saw-request", seen === null ? "no" : "yes");

  new HtmlRules()
    .prependInside("body", '<div id="hello-banner">rewritten at the edge</div>')
    .setAttr("html", "data-edge", "hello")
    .install();
});
