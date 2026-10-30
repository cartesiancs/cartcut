const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = {
  entry: {
    index: "./apps/app/src/index.ts",
    // Speech synthesis in a browser build runs in a worker, and a worker is a
    // script of its own: `features/tts/web/browserTts.ts` starts it from
    // beside index.js. The desktop app never loads it.
    ttsWorker: "./apps/app/src/features/tts/web/ttsWebWorker.ts",
  },
  watch: false,
  plugins: [new MiniCssExtractPlugin({ filename: `style.css` })],
  // ONNX Runtime's CommonJS build calls `require` on its Node-only branches
  // (`node:os` for a thread count the speech worker sets itself), which webpack
  // cannot resolve statically and need not: no browser takes them.
  ignoreWarnings: [
    {
      module: /node_modules[\\/]onnxruntime-web[\\/]/,
      message: /Critical dependency: require function is used/,
    },
  ],
  module: {
    // One file per entry, always. The renderer has no `import()` of its own, and the one
    // a dependency carries (`@mediabunny/aac-encoder` reaching for Node's
    // `worker_threads`, on a branch no browser takes) would otherwise emit a
    // chunk nothing loads.
    parser: { javascript: { dynamicImportMode: "eager" } },
    rules: [
      {
        test: /\.s[ac]ss$/i,
        use: [MiniCssExtractPlugin.loader, "css-loader", "sass-loader"],
      },
      {
        test: /\.ts?$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
      {
        // ONNX Runtime's WebAssembly (14 MB) and the script that loads it,
        // emitted beside the bundle under their own names and fetched only when
        // the speech worker first speaks (`features/tts/web/ttsWebWorker.ts`).
        test: /ort-wasm-simd-threaded\.(wasm|mjs)$/,
        include: /node_modules[\\/]onnxruntime-web[\\/]/,
        type: "asset/resource",
        generator: { filename: "[name][ext]" },
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  output: {
    filename: "[name].js",
    path: path.resolve(__dirname, "apps/app/dist"),
    library: "CARTCUT",
  },
};
