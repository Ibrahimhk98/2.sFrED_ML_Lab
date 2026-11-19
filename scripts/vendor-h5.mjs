import { cp, mkdir } from 'node:fs/promises';
await mkdir('dashboard/vendor/h5wasm', { recursive: true });
await cp('node_modules/h5wasm/dist/esm', 'dashboard/vendor/h5wasm', { recursive: true });
await cp('node_modules/h5wasm/LICENSE.txt', 'dashboard/vendor/h5wasm/LICENSE.txt');

// Bundle the numerical libraries once so the lab also works on a static server.
const { build } = await import('esbuild');
await build({
  stdin: { contents: "export {default as FFT} from 'fft.js'; export {Matrix, solve} from 'ml-matrix';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', outfile: 'dashboard/vendor/lab-math.js', legalComments: 'eof'
});
