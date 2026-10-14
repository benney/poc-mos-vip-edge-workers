// Compiles surface decisions into a compact rule IR and replays it as declarative
// HtmlRules.
import { JSON } from "json-as";
import { Headers, HtmlRules } from "@automattic/vip-edge-workers-sdk/assembly/index";
import { Config } from "./config";
import { SurfaceDecisions, WebElement } from "./decisions";
import { compileHttpBehavior, HttpOps } from "./behavior";

// Host caps: 256 rules / 64 KiB per install(). install() throws (= abort in AS),
// so we stay under budget ourselves rather than catching.
const MAX_RULES: i32 = 200;
const MAX_PAYLOAD: i32 = 56 * 1024;

@json
export class EdgeRule {
  o: string = ""; // ib | ia | pi | ai | rp
  s: string = "";
  h: string = "";
}

@json
export class EdgePlan {
  r: EdgeRule[] = [];
  a: string = ""; // anonymous identifier to persist ("" = none)
  h: HttpOps | null = null; // surfaceBehavior.http, response-phase ops only
}

function rule(op: string, selector: string, html: string): EdgeRule {
  const r = new EdgeRule();
  r.o = op;
  r.s = selector;
  r.h = html;
  return r;
}

/** Renders an `element` payload: `source:id@version` -> `<source-id version props>`. */
function renderComponentElement(el: WebElement): string {
  const schema = el.schema;
  if (schema === null) return "";
  const colon = schema.indexOf(":");
  if (colon < 0) return "";
  const source = schema.slice(0, colon);
  const rest = schema.slice(colon + 1);
  const at = rest.indexOf("@");
  const id = at < 0 ? rest : rest.slice(0, at);
  const version = at < 0 ? "" : rest.slice(at + 1);

  const tag = source + "-" + id;
  const props = el.props;
  const propsAttr = props === null ? "{}" : props.data.replaceAll('"', "&quot;");
  return "<" + tag + ' version="' + version + '" props="' + propsAttr + '"></' + tag + ">";
}

function escapeText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Unknown element types render empty rather than aborting. */
function renderElement(el: WebElement): string {
  const t = el.type.toLowerCase();
  if (t == "html") {
    const c = el.content;
    return c === null ? "" : c;
  }
  if (t == "text") {
    const c = el.content;
    return c === null ? "" : escapeText(c);
  }
  if (t == "element") return renderComponentElement(el);
  return "";
}

/** Concatenates a list into one HTML string — list order is preserved natively. */
function renderList(list: WebElement[] | null): string {
  if (list === null) return "";
  let out = "";
  for (let i = 0; i < list.length; i++) {
    out += renderElement(list[i]);
  }
  return out;
}

/** lol-html's CSS subset does not cover :last-child, so those selectors are skipped. */
function selectorSupported(selector: string): bool {
  if (selector.length == 0) return false;
  if (selector.includes(":last-child")) return false;
  return true;
}

export function compilePlan(cfg: Config, decisions: SurfaceDecisions): EdgePlan {
  const plan = new EdgePlan();

  const identifier = decisions.identity.identifier;
  if (identifier.length > 0) plan.a = identifier;

  const behavior = compileHttpBehavior(decisions.surfaceBehavior.http);
  if (behavior !== null && !behavior.ops.isEmpty()) plan.h = behavior.ops;

  if (cfg.injectScriptUrl.length > 0) {
    plan.r.push(rule("ai", "head", '<script src="' + cfg.injectScriptUrl + '" async defer></script>'));
  }

  if (decisions.componentsSkipped) return plan;

  const keys = decisions.componentBehaviors.keys();
  for (let i = 0; i < keys.length; i++) {
    const behavior = decisions.componentBehaviors.get(keys[i]);
    const content = behavior.content;
    const selector = behavior.metadata.cssSelector;
    if (content === null || selector === null) continue;
    if (!selectorSupported(selector)) continue;

    const before = renderList(content.before);
    const prepend = renderList(content.prepend);
    const append = renderList(content.append);
    const after = renderList(content.after);

    if (before.length > 0) plan.r.push(rule("ib", selector, before));
    if (after.length > 0) plan.r.push(rule("ia", selector, after));

    if (content.remove) {
      // before/after land outside the element boundary and survive; prepend/append
      // are inside and would be dropped, so they are not emitted here.
      plan.r.push(rule("rp", selector, ""));
    } else {
      if (prepend.length > 0) plan.r.push(rule("pi", selector, prepend));
      if (append.length > 0) plan.r.push(rule("ai", selector, append));
    }
  }

  return plan;
}

export function serializePlan(plan: EdgePlan): string {
  return JSON.stringify(plan);
}

/** Applies ops in order: replace-all, cookie reset, set, delete, append. */
export function applyHttpOps(ops: HttpOps, headers: Headers): i32 {
  if (ops.hrep) {
    const existing = headers.keys();
    for (let i = 0; i < existing.length; i++) headers.delete(existing[i]);
  }
  if (ops.ckreset) headers.delete("set-cookie");
  for (let i = 0; i < ops.hset.length; i++) headers.set(ops.hset[i].name, ops.hset[i].value);
  for (let i = 0; i < ops.hdel.length; i++) headers.delete(ops.hdel[i]);
  for (let i = 0; i < ops.ck.length; i++) headers.append("set-cookie", ops.ck[i]);
  return ops.st;
}

export function parsePlan(planJson: string): EdgePlan {
  return JSON.parse<EdgePlan>(planJson);
}

/** Replays the IR. Returns rules applied; 0 means nothing was installed. */
export function applyPlan(plan: EdgePlan): i32 {
  const rules = new HtmlRules();
  let applied: i32 = 0;
  let bytes: i32 = 0;

  for (let i = 0; i < plan.r.length; i++) {
    if (applied >= MAX_RULES) break;
    const r = plan.r[i];
    if (!selectorSupported(r.s)) continue;

    const cost = r.s.length + r.h.length + 16;
    if (bytes + cost > MAX_PAYLOAD) break;
    bytes += cost;

    if (r.o == "ib") rules.insertBefore(r.s, r.h);
    else if (r.o == "ia") rules.insertAfter(r.s, r.h);
    else if (r.o == "pi") rules.prependInside(r.s, r.h);
    else if (r.o == "ai") rules.appendInside(r.s, r.h);
    else if (r.o == "rp") rules.replace(r.s, r.h);
    else continue;

    applied++;
  }

  if (applied > 0) rules.install();
  return applied;
}
