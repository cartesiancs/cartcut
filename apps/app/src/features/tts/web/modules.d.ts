// The root tsconfig resolves modules the node10 way, which does not read a
// package's `exports`, so ONNX Runtime's subpaths are named here for their
// types. ts-loader emits CommonJS, so webpack takes the `require` condition:
// `ort.wasm.min.js`, which contains no `import.meta` (the ESM build's would be
// baked in as this machine's absolute path) and loads the two files below at
// run time from wherever `env.wasm.wasmPaths` says.
declare module "onnxruntime-web/wasm" {
  export * from "onnxruntime-web";
}

// Emitted beside the bundle as files (`asset/resource`): each import is a URL.
declare module "onnxruntime-web/ort-wasm-simd-threaded.wasm" {
  const url: string;
  export default url;
}
declare module "onnxruntime-web/ort-wasm-simd-threaded.mjs" {
  const url: string;
  export default url;
}
