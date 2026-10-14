// Cookie lookup over the SDK's parser, "" when absent, as the identity payload wants.
import { Cookies } from "@automattic/vip-edge-workers-sdk/assembly/index";

export function cookieValue(cookies: Cookies, name: string): string {
  const value = cookies.get(name);
  return value === null ? "" : value;
}
