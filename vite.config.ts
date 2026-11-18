import { defineConfig, Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Plugin ligero sin dependencias externas para servir y empaquetar
 * los Workers, Assets, ThirdParty y Widgets estáticos de CesiumJS.
 */
function cesiumStaticPlugin(): Plugin {
  const cesiumBuildPath = path.resolve(__dirname, 'node_modules/cesium/Build/Cesium');
  const cesiumBaseUrl = '/cesiumStatic';
  const dirs = ['Workers', 'ThirdParty', 'Assets', 'Widgets'];

  return {
    name: 'vite-plugin-cesium-static-zero-dep',
    config() {
      return {
        define: {
          CESIUM_BASE_URL: JSON.stringify(cesiumBaseUrl),
        },
      };
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
  },
});
