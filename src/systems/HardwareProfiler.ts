import { HardwareMemoryProfile } from '../types/zones';

/**
 * Detecta la GPU del cliente mediante WebGL y calcula el presupuesto de memoria (cacheBytes)
 * para los Cesium3DTilesets activos y en precarga:
 * - GPU Integrada (Intel Iris/UHD, AMD Radeon Graphics Vega integrada, Apple M-series básica / móvil): 1024 MB
 * - GPU Dedicada (NVIDIA RTX/GTX, AMD Radeon RX): 2048 MB
 */
export function detectHardwareMemoryProfile(canvas: HTMLCanvasElement): HardwareMemoryProfile {
  let rendererInfo = 'WebGL Generic Renderer';
  let isDedicated = false;

  try {
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');

    if (gl && 'getExtension' in gl) {
      const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const unmaskedRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        if (typeof unmaskedRenderer === 'string') {
          rendererInfo = unmaskedRenderer;
        }
      }
    }
  } catch {
    // Fallback silencioso a perfil conservador
  }

  const upper = rendererInfo.toUpperCase();
  if (
    upper.includes('NVIDIA') ||
    upper.includes('GEFORCE') ||
    upper.includes('RTX') ||
    upper.includes('GTX') ||
    upper.includes('RADEON RX') ||
    upper.includes('QUADRO')
  ) {
    isDedicated = true;
  }

  const totalCacheMB = isDedicated ? 2048 : 1024;
  const totalBytes = totalCacheMB * 1024 * 1024;

  // Asignamos 75% del presupuesto al tileset de la zona activa y 25% al tileset de precarga adyacente
  return {
    tier: isDedicated ? 'DEDICATED_GPU' : 'INTEGRATED_GPU',
    rendererInfo,
    totalCacheMB,
    activeZoneCacheBytes: Math.floor(totalBytes * 0.75),
    preloadZoneCacheBytes: Math.floor(totalBytes * 0.25),
    defaultMaximumScreenSpaceError: isDedicated ? 16 : 20,
  };
}
