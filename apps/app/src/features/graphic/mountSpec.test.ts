import { describe, expect, it } from "vitest";
import type { FxPreset } from "../fx/presetTypes";
import { mountSpecOf } from "./mountSpec";

function preset(html: string, css: string, assets: Record<string, string> = {}): FxPreset {
  return {
    schema: 1,
    id: "com.x.card",
    kind: "graphic",
    name: "Card",
    category: "layout",
    thumbnailPath: null,
    render: { type: "html", source: "index.html", styles: ["style.css"] },
    params: [],
    origin: "user",
    sources: { "index.html": html, "style.css": css },
    assets,
  };
}

describe("mountSpecOf", () => {
  it("sanitises the markup and filters the stylesheet again on read", () => {
    const built = mountSpecOf(
      preset('<h1 onclick="x()">a</h1><script>x()</script>', "h1 { background: url(https://evil/x.png); color: red }"),
    );
    expect(built).not.toBeNull();
    const json = JSON.stringify(built!.spec.nodes);
    expect(json).not.toMatch(/onclick|script/);
    expect(built!.spec.css).not.toMatch(/evil/);
    expect(built!.spec.css).toMatch(/color: red/);
    expect(built!.removed.length).toBeGreaterThanOrEqual(3);
  });

  it("hoists and renames registered properties per program", () => {
    const built = mountSpecOf(
      preset("<h1>a</h1>", '@property --angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; } h1 { --angle: 10deg; transform: rotate(var(--angle)); }'),
    )!;
    const renamed = built.spec.renames["--angle"];
    expect(renamed).toMatch(/^--g[0-9a-f]{8}-angle$/);
    expect(built.spec.propertyRules).toContain(renamed);
    expect(built.spec.css).toContain(`var(${renamed})`);
    expect(built.spec.css).not.toMatch(/@property/);
  });

  it("resolves asset references to file URLs", () => {
    const built = mountSpecOf(
      preset('<img src="asset:photo.png">', 'h1 { background-image: url("asset:photo.png") }', {
        "photo.png": "/abs/my photo.png",
      }),
    )!;
    expect(built.spec.assetUrls["photo.png"]).toBe("file:///abs/my%20photo.png");
    expect(built.spec.css).toContain('url("file:///abs/my%20photo.png")');
  });

  it("is remembered per preset object", () => {
    const p = preset("<h1>a</h1>", "h1{}");
    expect(mountSpecOf(p)).toBe(mountSpecOf(p));
  });
});
