const esbuild = require('esbuild');
const fs = require('fs');

fs.rmSync('dist', {recursive: true, force: true});

esbuild
  .build({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['vscode'],
  })
  .catch(() => process.exit(1));
