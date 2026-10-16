// MOS_DECISIONS_PERCENT: the share of readers whose pages get a surface decision.
import { getRandomValues, hexEncode, Request } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { Config } from "./config";
import { cookieValue } from "./cookies";

export const BUCKET_COOKIE = "mos_bucket";

export class Sample {
  inSample: bool = true;
  /** Set-Cookie for a reader who had no bucket yet. */
  setCookie: string | null = null;
}

/**
 * Sticky per reader: a random token in the bucket cookie, hashed to 0-99. A token rather than the
 * number itself, so a reader cannot simply pick a bucket outside the rollout.
 */
export function sampleReader(cfg: Config, req: Request): Sample {
  const sample = new Sample();
  if (cfg.decisionsPercent >= 100) return sample;
  if (cfg.decisionsPercent <= 0) {
    sample.inSample = false;
    return sample;
  }
  let token = cookieValue(req.cookies, BUCKET_COOKIE);
  if (token.length == 0) {
    token = hexEncode(getRandomValues(new Uint8Array(8)));
    sample.setCookie = BUCKET_COOKIE + "=" + token + "; Path=/; Max-Age=31536000; SameSite=Lax";
  }
  sample.inSample = bucketFor(token) < cfg.decisionsPercent;
  return sample;
}

/** 0-99, from FNV-1a of the token. */
export function bucketFor(token: string): i32 {
  let hash: u32 = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= <u32>token.charCodeAt(i);
    hash *= 0x01000193;
  }
  return <i32>(hash % 100);
}
