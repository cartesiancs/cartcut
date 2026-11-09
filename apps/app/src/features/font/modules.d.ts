// Emitted beside the bundle as a file (`asset/resource`): the import is a URL.
// Named here because the root tsconfig resolves modules the node10 way, which
// does not read harfbuzzjs's `exports`.
declare module "harfbuzzjs/dist/harfbuzz-subset.wasm" {
  const url: string;
  export default url;
}
