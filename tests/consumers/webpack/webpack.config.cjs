const path = require('node:path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// ESM output is required, not cosmetic: the package ships `type: module` and
// reaches its worker through `new Worker(new URL(…, import.meta.url))`, which
// only survives in a module chunk.
module.exports = {
  mode: 'production',
  entry: './src/index.js',
  target: 'web',
  experiments: { outputModule: true },
  output: {
    module: true,
    chunkFormat: 'module',
    filename: 'main.js',
    clean: true,
    path: path.resolve(__dirname, 'dist'),
  },
  plugins: [
    new HtmlWebpackPlugin({
      template: './index.html',
      scriptLoading: 'module',
    }),
  ],
};
