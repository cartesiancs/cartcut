/**
 * Local and cloud items, as one ordered list per grid. Pure.
 *
 * The rule, in the FX tab's sections and the Templates panel's Cloud section
 * alike:
 *
 * 1. Local items first, in the order they already had.
 * 2. Then every cloud item by name, **downloaded or not**. A downloaded one is
 *    an ordinary installed preset (origin `"cloud"`), and sorting the two
 *    together is what keeps a tile where it was when its download finishes.
 * 3. A catalog item whose id is already installed is shown once, as the
 *    installed one, so a local preset is never offered again as a cloud tile.
 * 4. A downloaded item missing from the catalog (offline, setting off, pulled
 *    from the server) is still shown: a project may be using it.
 * 5. An item this build cannot read (another preset schema, a template
 *    document schema it does not know) is not offered at all.
 */

import type { FxPreset } from "../fx/presetTypes";
import type { TemplateListing } from "../template/templateRegistry";
import type { CloudItem } from "./cloudTypes";

/** The preset schema this build reads. `presetValidate.ts` refuses any other. */
const PRESET_SCHEMA = 1;

export type FxTile =
  | { type: "preset"; preset: FxPreset }
  | { type: "cloud"; item: CloudItem };

export type TemplateTile =
  | { type: "template"; listing: TemplateListing }
  | { type: "cloud"; item: CloudItem };

type Named<T> = { name: string; id: string; tile: T };

function byNameThenId<T>(a: Named<T>, b: Named<T>): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/**
 * One grid's presets and catalog, local first. `presets` is in the registry's
 * display order, where downloaded cloud presets already sort last.
 */
export function mergeFxTiles(
  presets: readonly FxPreset[],
  catalog: readonly CloudItem[],
): FxTile[] {
  const installed = new Set(presets.map((preset) => preset.id));
  const local = presets.filter((preset) => preset.origin !== "cloud");

  const cloud: Named<FxTile>[] = [
    ...presets
      .filter((preset) => preset.origin === "cloud")
      .map((preset) => ({
        name: preset.name,
        id: preset.id,
        tile: { type: "preset", preset } as FxTile,
      })),
    ...catalog
      .filter((item) => !installed.has(item.id) && item.schema === PRESET_SCHEMA)
      .map((item) => ({ name: item.name, id: item.id, tile: { type: "cloud", item } as FxTile })),
  ].sort(byNameThenId);

  return [
    ...local.map((preset): FxTile => ({ type: "preset", preset })),
    ...cloud.map((entry) => entry.tile),
  ];
}

/** The category a tile is filed under in the FX tab's sections. */
export function fxTileCategory(tile: FxTile): string | null {
  return tile.type === "preset" ? tile.preset.category : tile.item.category;
}

/**
 * The Templates panel's Cloud section: downloaded cloud templates and the
 * catalog's others, by name. `readable` is `isReadableSchemaVersion`, passed
 * in so this module stays free of the timeline's imports.
 */
export function cloudTemplateTiles(
  listings: readonly TemplateListing[],
  catalog: readonly CloudItem[],
  readable: (schema: unknown) => boolean,
): TemplateTile[] {
  const installed = new Set(listings.map((listing) => listing.id));
  return [
    ...listings
      .filter((listing) => listing.origin === "cloud")
      .map((listing) => ({
        name: listing.name,
        id: listing.id,
        tile: { type: "template", listing } as TemplateTile,
      })),
    ...catalog
      .filter((item) => !installed.has(item.id) && readable(item.schema))
      .map((item) => ({
        name: item.name,
        id: item.id,
        tile: { type: "cloud", item } as TemplateTile,
      })),
  ]
    .sort(byNameThenId)
    .map((entry) => entry.tile);
}

/**
 * The asset browser's cloud view: the catalog, with what is on disk folded
 * in, plus anything downloaded the catalog no longer lists. Offline the
 * catalog is empty and this is exactly the downloaded set.
 */
export function cloudAssetTiles(
  installed: readonly CloudItem[],
  catalog: readonly CloudItem[],
): CloudItem[] {
  const byId = new Map<string, CloudItem>();
  for (const item of catalog) {
    byId.set(item.id, item);
  }
  for (const local of installed) {
    const listed = byId.get(local.id);
    byId.set(
      local.id,
      listed == null
        ? local
        : {
            ...listed,
            installed: true,
            localPath: local.localPath,
            localThumbnail: local.localThumbnail,
          },
    );
  }
  return [...byId.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/** Matched against name, category and author, as the local grids are. */
export function cloudItemMatches(item: CloudItem, query: string, categoryLabel = ""): boolean {
  if (query === "") {
    return true;
  }
  return [item.name, item.category ?? "", categoryLabel, item.author ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(query);
}
