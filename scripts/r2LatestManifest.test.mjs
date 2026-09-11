import { buildManifest, slotOf } from "./r2LatestManifest.mjs";

const BASE = "https://download.cartesiancs.com/cartcut";

// The asset list of the real v0.5.3 release, as `gh release view` reports it.
const V053 = {
  tagName: "v0.5.3",
  publishedAt: "2026-09-09T13:14:24Z",
  assets: [
    { name: "Cartcut-0.5.3-arm64-mac.zip", size: 1109051370 },
    { name: "Cartcut-0.5.3-arm64-mac.zip.blockmap", size: 1153438 },
    { name: "Cartcut-0.5.3-arm64.dmg", size: 1124293562 },
    { name: "Cartcut-0.5.3-arm64.dmg.blockmap", size: 1128324 },
    { name: "Cartcut-0.5.3-mac.zip", size: 1118986333 },
    { name: "Cartcut-0.5.3-mac.zip.blockmap", size: 1165710 },
    { name: "Cartcut-0.5.3.dmg", size: 1134483012 },
    { name: "Cartcut-0.5.3.dmg.blockmap", size: 1137648 },
    { name: "latest-mac.yml", size: 803 },
  ],
};

describe("buildManifest", () => {
  it("maps the v0.5.3 release onto the two mac downloads", () => {
    expect(buildManifest(V053, BASE)).toEqual({
      version: "0.5.3",
      tag: "v0.5.3",
      releasedAt: "2026-09-09T13:14:24Z",
      notesUrl: "https://github.com/cartesiancs/cartcut/releases/tag/v0.5.3",
      mac: {
        arm64: {
          url: `${BASE}/v0.5.3/Cartcut-0.5.3-arm64.dmg`,
          size: 1124293562,
        },
        x64: { url: `${BASE}/v0.5.3/Cartcut-0.5.3.dmg`, size: 1134483012 },
      },
    });
  });

  it("tolerates a trailing slash on the base url", () => {
    expect(buildManifest(V053, `${BASE}/`).mac.x64.url).toBe(
      `${BASE}/v0.5.3/Cartcut-0.5.3.dmg`,
    );
  });

  it("adds a windows entry only when the release carries an installer", () => {
    // GitHub replaces the spaces in electron-builder's default NSIS name.
    const withWin = {
      ...V053,
      assets: [...V053.assets, { name: "Cartcut.Setup.0.5.3.exe", size: 42 }],
    };
    expect(buildManifest(withWin, BASE).win).toEqual({
      x64: { url: `${BASE}/v0.5.3/Cartcut.Setup.0.5.3.exe`, size: 42 },
    });
    expect(buildManifest(V053, BASE).win).toBeUndefined();
  });

  it("percent-encodes names a url cannot carry raw", () => {
    const odd = {
      ...V053,
      assets: [{ name: "Cartcut 0.5.3 #1.dmg", size: 1 }],
    };
    expect(buildManifest(odd, BASE).mac.x64.url).toBe(
      `${BASE}/v0.5.3/Cartcut%200.5.3%20%231.dmg`,
    );
  });

  it("refuses a release with no dmg rather than publish an empty manifest", () => {
    const noDmg = {
      ...V053,
      assets: V053.assets.filter((a) => !a.name.endsWith(".dmg")),
    };
    expect(() => buildManifest(noDmg, BASE)).toThrow(/no \.dmg/);
  });
});

describe("slotOf", () => {
  it("ignores blockmaps, zips and the updater manifest", () => {
    expect(slotOf("Cartcut-0.5.3-arm64.dmg.blockmap")).toBeNull();
    expect(slotOf("Cartcut-0.5.3-arm64-mac.zip")).toBeNull();
    expect(slotOf("latest-mac.yml")).toBeNull();
  });
});
