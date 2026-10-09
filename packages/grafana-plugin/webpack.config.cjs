const path = require('node:path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: './src/module.tsx',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'module.js',
    library: { type: 'amd' },
    clean: true,
  },
  externals: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    /^@grafana\/data/,
    /^@grafana\/runtime/,
    /^@grafana\/ui/,
  ],
  module: {
    rules: [{
      test: /\.tsx?$/,
      use: { loader: 'ts-loader', options: { compilerOptions: { noEmit: false } } },
      exclude: /node_modules/,
    }],
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  plugins: [new CopyPlugin({ patterns: [{ from: 'src/plugin.json', to: 'plugin.json' }] })],
};
