import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

function resolveRunnerBackendTarget(env: Record<string, string>): string {
  const port = env.CGFLOW_RUNNER_PORT ?? env.VITE_RUNNER_PORT ?? '45731';
  return `http://127.0.0.1:${port}`;
}

// Web-only config (no Electron) for headless development
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const runnerProxyPath = env.VITE_RUNNER_URL?.startsWith('/')
    ? env.VITE_RUNNER_URL.replace(/\/$/, '')
    : null;

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        '@shared': path.resolve(__dirname, './shared'),
      },
    },
    build: {
      outDir: 'dist',
    },
    server: {
      watch: {
        usePolling: true,
        interval: 1000,
      },
      ...(runnerProxyPath
        ? {
            proxy: {
              [runnerProxyPath]: {
                target: resolveRunnerBackendTarget(env),
                changeOrigin: true,
                rewrite: (requestPath) =>
                  requestPath.replace(new RegExp(`^${runnerProxyPath}`), '') || '/',
              },
            },
          }
        : {}),
    },
  };
});
