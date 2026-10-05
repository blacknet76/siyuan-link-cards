const path = require("node:path");
const fs = require("node:fs");
const webpack = require("webpack");
const { EsbuildPlugin } = require("esbuild-loader");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyPlugin = require("copy-webpack-plugin");
const ZipPlugin = require("zip-webpack-plugin");

const screenshotNames = [
  "link-cards-light.png",
  "link-cards-dark.png",
  "insert-dialog.png",
  "youtube-preview.png",
];
// DEV and its allowlisted PUBLIC export expose the same packaged README paths.
const screenshotSource = fs.existsSync(path.join(__dirname, "public-assets/screenshots"))
  ? "public-assets/screenshots"
  : "docs/screenshots";

module.exports = (_env, argv) => {
  const production = argv.mode === "production";
  return {
    mode: argv.mode,
    entry: "./src/index.ts",
    output: {
      path: path.resolve(__dirname, production ? "dist" : "dev"),
      filename: "index.js",
      library: { type: "commonjs2" },
      clean: true,
    },
    externals: { siyuan: "siyuan" },
    devtool: production ? false : "source-map",
    resolve: { extensions: [".ts", ".js"], extensionAlias: { ".ts": [".ts"] } },
    module: {
      rules: [
        {
          test: /\.ts$/,
          include: path.resolve(__dirname, "src"),
          loader: "esbuild-loader",
          options: { target: "es2022" },
        },
        { test: /\.svg$/, type: "asset/source" },
        { test: /\.css$/, use: [MiniCssExtractPlugin.loader, "css-loader"] },
      ],
    },
    optimization: {
      minimize: production,
      // Preserve SiYuan's CommonJS entry; the web-target IIFE default hides module.exports.
      minimizer: [new EsbuildPlugin({ target: "es2022", format: "cjs" })],
    },
    plugins: [
      new webpack.DefinePlugin({ __DEV__: JSON.stringify(!production) }),
      new MiniCssExtractPlugin({ filename: "index.css" }),
      new CopyPlugin({
        patterns: [
          { from: "plugin.json" },
          { from: "icon.png" },
          { from: "LICENSE" },
          { from: "THIRD_PARTY_NOTICES.md" },
          { from: "README*.md" },
          ...screenshotNames.map(name => ({
            from: path.join(__dirname, screenshotSource, name),
            to: `docs/screenshots/${name}`,
          })),
          { from: "src/i18n", to: "i18n" },
          // SiYuan 3.8.6 uses the canonical language code "de"; keep one German source.
          { from: "src/i18n/de-DE.json", to: "i18n/de.json" },
        ],
      }),
      ...(production
        ? [
          new webpack.BannerPlugin({ banner: fs.readFileSync("LICENSE", "utf8") }),
          new ZipPlugin({ path: path.resolve(__dirname), filename: "package.zip", exclude: [/\.map$/] }),
        ]
        : []),
    ],
  };
};
