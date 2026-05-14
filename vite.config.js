import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Build modes:
//   • default — full multi-entry build (index.html + controller.html) used
//     by the Express server.js to host the LAN/coop experience.
//   • yandex  — single-player static build for Yandex Games. Drops the
//     iPhone controller entry entirely, outputs to `dist-yandex/`, and
//     defines `import.meta.env.VITE_PLATFORM === 'yandex'` so the
//     Yandex SDK code paths in src/yandex/* light up.
export default defineConfig(({ mode }) => {
  const isYandex = mode === 'yandex';
  return {
    root: '.',
    define: {
      'import.meta.env.VITE_PLATFORM': JSON.stringify(isYandex ? 'yandex' : 'web'),
    },
    build: {
      outDir: isYandex ? 'dist-yandex' : 'dist',
      sourcemap: true,
      target: 'es2020',
      // Yandex Games packages relative paths inside the uploaded zip;
      // forcing './' ensures all asset URLs work whether the host serves
      // from a subdirectory or the root of the iframe.
      ...(isYandex ? { base: './' } : {}),
      rollupOptions: {
        input: isYandex
          ? { main: path.resolve(__dirname, 'index.html') }
          : {
              main: path.resolve(__dirname, 'index.html'),
              controller: path.resolve(__dirname, 'controller.html'),
            },
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      strictPort: true,
      allowedHosts: true,
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true,
    },
  };
});
