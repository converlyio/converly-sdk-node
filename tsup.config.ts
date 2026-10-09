import { defineConfig } from 'tsup';

// Dual ESM + CJS build with per-format type declarations.
//
//   dist/index.js    ESM entry   (package.json "exports".import)
//   dist/index.cjs   CJS entry   (package.json "exports".require)
//   dist/index.d.ts  ESM types
//   dist/index.d.cts CJS types
//
// Everything under src/ is bundled into a single file per format, so the
// published package has zero runtime dependencies and no internal module
// graph for consumers to resolve.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
  target: 'node18',
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  minify: false,
});
