// Origin-trial tokens for the web build, written into its index.html.
//
// HTML graphics draw through Chrome's html-in-canvas API (`CanvasDrawElement`).
// The desktop app switches it on for its own window (electron/lib/window.ts),
// and Chrome and Edge turn it on by default from 157. Chrome 155 and 156 expose
// it only to a page whose origin presents a token for the trial, from
// https://developer.chrome.com/origintrials; without one, every HTML graphic in
// a browser build draws nothing there.
//
// A token is bound to one origin, so the site and its Cloudflare Pages
// deployments each need their own; registering the Pages project's
// `<project>.pages.dev` with subdomains matched covers every preview. Tokens
// are public by design (Chrome reads them from the page), so the file is
// committed: apps/app/origin-trial.txt, one token per line, `#` for a comment.

/** The tokens in the file's text, in order. */
export function parseTokens(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// A token is base64. Anything else is refused rather than escaped: this text
// is spliced into the page's <head>, and a quote in it would end the attribute.
const TOKEN = /^[A-Za-z0-9+/]+={0,2}$/;

/** `html` with one `<meta http-equiv="origin-trial">` per token, first in its <head>. */
export function withOriginTrials(html, tokens) {
  if (tokens.length === 0) {
    return html;
  }
  for (const token of tokens) {
    if (!TOKEN.test(token)) {
      throw new Error(`origin-trial.txt: not a token: ${token.slice(0, 24)}...`);
    }
  }
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head == null) {
    throw new Error("index.html has no <head> to put the origin-trial tokens in");
  }
  const at = head.index + head[0].length;
  const metas = tokens.map((token) => `\n        <meta http-equiv="origin-trial" content="${token}">`).join("");
  return html.slice(0, at) + metas + html.slice(at);
}
