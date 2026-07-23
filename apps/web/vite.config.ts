import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';

const webRoot = fileURLToPath(new URL('.', import.meta.url));
const protocolSource = fileURLToPath(
  new URL('../../packages/protocol/src/index.ts', import.meta.url),
);
const mediaPolicySource = fileURLToPath(
  new URL('../../packages/media-policy/src/index.ts', import.meta.url),
);

/** Map clean /admin URLs to the multi-page admin.html entry during dev. */
function adminDevRewrite(): Plugin {
  return {
    name: 'wo-admin-dev-rewrite',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const url = request.url ?? '';
        if (url === '/admin' || url.startsWith('/admin?') || url.startsWith('/admin/')) {
          request.url = `/admin.html${url.includes('?') ? url.slice(url.indexOf('?')) : ''}`;
        }
        next();
      });
    },
  };
}

const rnnoiseStub = resolve(webRoot, 'src/rnnoise-stub.ts');

export default defineConfig({
  appType: 'mpa',
  plugins: [react(), adminDevRewrite()],
  resolve: {
    alias: {
      '@wo/media-policy': mediaPolicySource,
      '@wo/protocol': protocolSource,
      // Desktop-only WASM; browsers use Chromium noiseSuppression instead.
      '@shiguredo/rnnoise-wasm': rnnoiseStub,
    },
    dedupe: ['lucide-react', 'react', 'react-dom'],
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(webRoot, 'index.html'),
        admin: resolve(webRoot, 'admin.html'),
      },
    },
  },
  server: {
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:3000',
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
