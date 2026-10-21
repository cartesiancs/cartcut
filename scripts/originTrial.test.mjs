import { describe, expect, it } from "vitest";
import { parseTokens, withOriginTrials } from "./originTrial.mjs";

const PAGE = `<!DOCTYPE html>\n<html lang="ko">\n    <head>\n        <meta charset="utf-8">\n    </head>\n</html>\n`;
const TOKEN_A = "A2x0b2tlbi1mb3ItY2FydGN1dC5jYXJ0ZXNpYW5jcy5jb20=";
const TOKEN_B = "Ab3R0b2tlbi1mb3ItY2FydGN1dC5wYWdlcy5kZXY";

describe("parseTokens", () => {
  it("reads one token per line and skips blanks and comments", () => {
    const text = `# cartcut.cartesiancs.com\n${TOKEN_A}\n\n  # cartcut.pages.dev, subdomains matched\n  ${TOKEN_B}  \r\n`;
    expect(parseTokens(text)).toEqual([TOKEN_A, TOKEN_B]);
  });

  it("reads nothing from an empty or absent file", () => {
    expect(parseTokens("")).toEqual([]);
    expect(parseTokens(undefined)).toEqual([]);
  });
});

describe("withOriginTrials", () => {
  it("leaves the page alone with no tokens", () => {
    expect(withOriginTrials(PAGE, [])).toBe(PAGE);
  });

  it("puts a meta per token first in the head", () => {
    const out = withOriginTrials(PAGE, [TOKEN_A, TOKEN_B]);
    const metas = out.match(/<meta http-equiv="origin-trial" content="([^"]+)">/g) ?? [];
    expect(metas).toHaveLength(2);
    expect(out.indexOf(TOKEN_A)).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf(TOKEN_B)).toBeLessThan(out.indexOf('<meta charset="utf-8">'));
    // Nothing else moved.
    expect(out.replace(/\n {8}<meta http-equiv="origin-trial"[^>]*>/g, "")).toBe(PAGE);
  });

  it("refuses a line that is not a token rather than writing it into the page", () => {
    expect(() => withOriginTrials(PAGE, ['abc"><script>alert(1)</script>'])).toThrow(/not a token/);
  });

  it("refuses a page with no head", () => {
    expect(() => withOriginTrials("<html></html>", [TOKEN_A])).toThrow(/no <head>/);
  });
});
