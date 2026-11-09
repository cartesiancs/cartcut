/**
 * Cutting a font down to the glyphs a graphic can show, with HarfBuzz's
 * `hb-subset` compiled to WebAssembly (harfbuzzjs's `harfbuzz-subset.wasm`,
 * MIT, 683 KB, no imports, so it is instantiated with nothing and no
 * JavaScript glue is loaded).
 *
 * What is kept, and why, measured in `tests/e2e/FINDINGS.md` section 11:
 * every layout feature, script and name, and an empty drop-table list, so the
 * subset shapes as the full face does (kerning, ligatures, small caps,
 * variation axes); unrecognised tables passed through; a drawn `.notdef`. With
 * those, 28 of the 30 bundled faces lay out to 0.01 px of the full face in
 * Chromium, Firefox and WebKit, and the other two need `retainGids`
 * (`fontPlan.ts#embedPlan`).
 *
 * The exports are a port, so node runs the same wasm in the suite.
 */

export type SubsetExports = {
  memory: WebAssembly.Memory;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(data: number, length: number, mode: number, user: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_length(blob: number): number;
  hb_blob_get_data(blob: number, length: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, value: number): void;
  hb_set_clear(set: number): void;
  hb_set_invert(set: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_input_set(input: number, which: number): number;
  hb_subset_input_set_flags(input: number, flags: number): void;
  hb_subset_or_fail(face: number, input: number): number;
};

/** `hb_subset_sets_t`. */
const SETS_DROP_TABLE_TAG = 3;
const SETS_NAME_ID = 4;
const SETS_NAME_LANG_ID = 5;
const SETS_LAYOUT_FEATURE_TAG = 6;
const SETS_LAYOUT_SCRIPT_TAG = 7;

/** `hb_subset_flags_t`. */
const FLAG_RETAIN_GIDS = 0x2;
const FLAG_PASSTHROUGH_UNRECOGNIZED = 0x20;
const FLAG_NOTDEF_OUTLINE = 0x40;

/** `HB_MEMORY_MODE_WRITABLE`: HarfBuzz may use the bytes in place. */
const MEMORY_MODE_WRITABLE = 2;

export type Subsetter = (
  font: Uint8Array,
  codepoints: readonly number[],
  options: { retainGids: boolean },
) => Uint8Array | null;

export function subsetterFrom(x: SubsetExports): Subsetter {
  return (font, codepoints, { retainGids }) => {
    const pointer = x.malloc(font.length);
    if (pointer === 0) {
      return null;
    }
    new Uint8Array(x.memory.buffer).set(font, pointer);
    const blob = x.hb_blob_create(pointer, font.length, MEMORY_MODE_WRITABLE, 0, 0);
    const face = x.hb_face_create(blob, 0);
    x.hb_blob_destroy(blob);
    const input = x.hb_subset_input_create_or_fail();
    try {
      if (input === 0) {
        return null;
      }
      const unicodes = x.hb_subset_input_unicode_set(input);
      for (const cp of codepoints) {
        x.hb_set_add(unicodes, cp);
      }
      for (const which of [SETS_LAYOUT_FEATURE_TAG, SETS_LAYOUT_SCRIPT_TAG, SETS_NAME_ID, SETS_NAME_LANG_ID]) {
        const set = x.hb_subset_input_set(input, which);
        x.hb_set_clear(set);
        x.hb_set_invert(set);
      }
      x.hb_set_clear(x.hb_subset_input_set(input, SETS_DROP_TABLE_TAG));
      x.hb_subset_input_set_flags(
        input,
        FLAG_PASSTHROUGH_UNRECOGNIZED | FLAG_NOTDEF_OUTLINE | (retainGids ? FLAG_RETAIN_GIDS : 0),
      );
      const subset = x.hb_subset_or_fail(face, input);
      if (subset === 0) {
        return null;
      }
      const out = x.hb_face_reference_blob(subset);
      const length = x.hb_blob_get_length(out);
      const data = x.hb_blob_get_data(out, 0);
      // Copied out before anything frees it: the heap can move on the next malloc.
      const bytes = new Uint8Array(x.memory.buffer).slice(data, data + length);
      x.hb_blob_destroy(out);
      x.hb_face_destroy(subset);
      return bytes.length > 0 ? bytes : null;
    } finally {
      if (input !== 0) {
        x.hb_subset_input_destroy(input);
      }
      x.hb_face_destroy(face);
      x.free(pointer);
    }
  };
}

/** Fetch and instantiate the wasm at `url`. */
export async function loadSubsetter(url: string): Promise<Subsetter> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`hb-subset: ${response.status} fetching ${url}`);
  }
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
  return subsetterFrom(instance.exports as unknown as SubsetExports);
}
