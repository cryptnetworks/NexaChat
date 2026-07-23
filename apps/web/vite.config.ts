import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const proxyTarget =
  process.env.NEXA_DEV_PROXY_TARGET ?? 'http://localhost:3000';
const cacheDir = process.env.NEXA_DEV_CACHE_DIR;
const parsedProxyTarget = new URL(proxyTarget);
if (
  !['http:', 'https:'].includes(parsedProxyTarget.protocol) ||
  parsedProxyTarget.username ||
  parsedProxyTarget.password ||
  parsedProxyTarget.pathname !== '/' ||
  parsedProxyTarget.search ||
  parsedProxyTarget.hash
)
  throw new Error('NEXA_DEV_PROXY_TARGET must be an HTTP origin');

export default defineConfig({
  ...(cacheDir === undefined ? {} : { cacheDir }),
  plugins: [react()],
  server: {
    strictPort: true,
    proxy: {
      '/v1': { target: proxyTarget, ws: true },
      '/health': proxyTarget,
    },
  },
});
