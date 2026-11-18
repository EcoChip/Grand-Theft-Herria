import { defineConfig, Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Plugin zero-dep para CesiumJS + soporte dual:
 * - En `npm run dev`: sirve /src/main.ts con HMR y /cesiumStatic desde node_modules.
 * - En `npm run build`: empaqueta dist/main.js + dist/cesiumStatic con rutas relativas a import.meta.url,
 *   permitiendo que GitHub Pages funcione directamente desde la raíz de la rama `main` sin pasos extra.
 */
function cesiumStaticPlugin(): Plugin {
  const cesiumBuildPath = path.resolve(__dirname, 'node_modules/cesium/Build/Cesium');
  const cesiumBaseUrl = '/cesiumStatic';
  const dirs = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

  return {
    name: 'vite-plugin-cesium-static-zero-dep',
    config(_, { command }) {
      const isBuild = command === 'build';
      return {
        base: './',
        define: isBuild
          ? {}
          : {
              CESIUM_BASE_URL: JSON.stringify(cesiumBaseUrl),
            },
        build: {
          outDir: 'dist',
          emptyOutDir: true,
          rollupOptions: {
            output: {
              entryFileNames: 'main.js',
              chunkFileNames: 'assets/[name].js',
              assetFileNames: 'assets/[name][extname]',
            },
          },
        },
      };
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        // En `npm run dev` (ctx.server existe), apuntamos a /cesiumStatic y /src/main.ts
        // En `npm run build`, apuntamos la entrada a /src/main.ts antes de que Rollup escanee el HTML
        let transformed = html.replace('./dist/main.js', '/src/main.ts');
        if (ctx.server) {
          transformed = transformed.replaceAll('./dist/cesiumStatic/', '/cesiumStatic/');
        }
        return transformed;
      },
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith(cesiumBaseUrl)) {
          const relPath = req.url.slice(cesiumBaseUrl.length).split('?')[0];
          const filePath = path.join(cesiumBuildPath, relPath);
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.js': 'application/javascript',
              '.css': 'text/css',
              '.json': 'application/json',
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.svg': 'image/svg+xml',
              '.wasm': 'application/wasm',
              '.xml': 'application/xml',
            };
            if (mimeTypes[ext]) {
              res.setHeader('Content-Type', mimeTypes[ext]);
            }
            fs.createReadStream(filePath).pipe(res);
            return;
          }
        }
        next();
      });
    },
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist', 'cesiumStatic');
      for (const dir of dirs) {
        const srcDir = path.join(cesiumBuildPath, dir);
        const destDir = path.join(outDir, dir);
        if (fs.existsSync(srcDir)) {
          fs.cpSync(srcDir, destDir, { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [cesiumStaticPlugin()],
  server: {
    port: 5173,
    open: false,
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
      },
    },
  },
});
