// Exercises the SDK's host-executed crypto: signed-request verification and HS256
// session tokens. No hash code lives in the binary — every primitive is a host call.
import {
  getenv, hexEncode, hmacSha256Str, jwtVerifyHs256, onClientRequest,
  Request, secureCompare, sha256,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

export {
  alloc,
  on_client_request,
  needs_client_request_body,
} from "@automattic/vip-edge-workers-sdk/assembly/index";

const SIGNATURE_HEADER = "x-payload-signature";

onClientRequest((req: Request): void => {
  // Reject a request body whose HMAC does not match the one the caller sent.
  if (req.url == "/verify-signature") {
    const signingKey = getenv("PAYLOAD_SIGNING_KEY");
    if (signingKey === null) { req.respondText(500, "signing key unset"); return; }

    const sent = req.headers.get(SIGNATURE_HEADER);
    if (sent === null) { req.respondText(401, "signature header absent"); return; }

    const body = req.text();
    const computed = "sha256=" + hexEncode(hmacSha256Str(signingKey, body === null ? "" : body));
    const matches = secureCompare(
      Uint8Array.wrap(String.UTF8.encode(sent)),
      Uint8Array.wrap(String.UTF8.encode(computed)),
    );
    req.respondText(matches ? 200 : 401, matches ? "signature ok" : "signature mismatch");
    return;
  }

  // Verify a session token and hand its payload to origin.
  if (req.url == "/session") {
    const header = req.headers.get("authorization");
    if (header === null || !header.startsWith("Bearer ")) { req.respondText(401, "bearer token absent"); return; }

    const payload = jwtVerifyHs256(header.slice(7), getenv("SESSION_TOKEN_KEY") || "");
    if (payload === null) { req.respondText(401, "token rejected"); return; }
    req.headers.set("x-session-payload", payload);
    return;
  }

  // Plain digest, to show sha256 on its own.
  if (req.url == "/digest") {
    const body = req.text();
    req.respondText(200, hexEncode(sha256(Uint8Array.wrap(String.UTF8.encode(body === null ? "" : body)))));
  }
});
