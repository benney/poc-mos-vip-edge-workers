// Applies the worker's declarative rules with real lol-html — the same engine the VIP
// host uses — so harness output matches production rewriting.
//
// html-rewriter-wasm is CommonJS and instantiates its 906 KB module *synchronously* at
// import time. That exceeds the browser's 4 KB main-thread sync-compile limit, so in a
// browser this module must only be imported from a Web Worker (see web/worker.mjs).
import { HTMLRewriter } from 'html-rewriter-wasm';

export async function applyHtmlRules(html, rules) {
    if (rules.length === 0) return html;
    let out = '';
    const decoder = new TextDecoder();
    const rewriter = new HTMLRewriter((chunk) => { out += decoder.decode(chunk, { stream: true }); });
    try {
        for (const rule of rules) {
            const [a, b, c] = rule.args;
            switch (rule.op) {
                case 'insertBefore': rewriter.on(rule.selector, { element: (e) => e.before(a, { html: true }) }); break;
                case 'insertAfter': rewriter.on(rule.selector, { element: (e) => e.after(a, { html: true }) }); break;
                case 'prependInside': rewriter.on(rule.selector, { element: (e) => e.prepend(a, { html: true }) }); break;
                case 'appendInside': rewriter.on(rule.selector, { element: (e) => e.append(a, { html: true }) }); break;
                case 'replace': rewriter.on(rule.selector, { element: (e) => e.replace(a, { html: true }) }); break;
                case 'remove': rewriter.on(rule.selector, { element: (e) => e.remove() }); break;
                case 'setAttr': rewriter.on(rule.selector, { element: (e) => e.setAttribute(a, b) }); break;
                case 'removeAttr': rewriter.on(rule.selector, { element: (e) => e.removeAttribute(a) }); break;
                case 'setText': rewriter.on(rule.selector, { element: (e) => e.setInnerContent(a, { html: false }) }); break;
                case 'rewriteAttrRe':
                    rewriter.on(rule.selector, {
                        element: (e) => {
                            const cur = e.getAttribute(a);
                            if (cur !== null) e.setAttribute(a, cur.replace(new RegExp(b, 'g'), c.replace(/\$0/g, '$&')));
                        },
                    });
                    break;
                default: throw new Error(`unknown rule op ${rule.op}`);
            }
        }
        await rewriter.write(new TextEncoder().encode(html));
        await rewriter.end();
    } finally {
        rewriter.free();
    }
    return out + decoder.decode();
}
