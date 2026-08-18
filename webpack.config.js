const path = require("path");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");

module.exports = {
  entry: ["./apps/app/src/index.ts"],
  watch: false,
  plugins: [new MiniCssExtractPlugin({ filename: `style.css` })],
  module: {
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
    alias: {
      // Unified rendering engine — consumed as TS source (ts-loader transpiles it).
      "@nugget/preview-engine": path.resolve(
        __dirname,
        "packages/preview-engine/src",
      ),
    },
  },
  output: {
    filename: "index.js",
    path: path.resolve(__dirname, "apps/app/dist"),
    library: "NUGGET",
  },
};
