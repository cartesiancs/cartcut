const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = {
  entry: ["./apps/app/src/index.ts"],
  watch: false,
  plugins: [new MiniCssExtractPlugin({ filename: `style.css` })],
  module: {
    // One file, always. The renderer has no `import()` of its own, and the one
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
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  output: {
    filename: "index.js",
    path: path.resolve(__dirname, "apps/app/dist"),
    library: "CARTCUT",
  },
};
