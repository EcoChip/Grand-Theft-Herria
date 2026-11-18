/**
 * Identificadores únicos de los 5 municipios del Gran Bilbao incluidos en el prototipo.
 */
export type ZoneId = 'bilbao' | 'portugalete' | 'getxo' | 'santurtzi' | 'basauri';

/**
 * Bounding Box geográfico en grados decimales (WGS84).
 */
export interface GeoBoundingBox {
  west: number;  // Longitud mínima
  south: number; // Latitud mínima
  east: number;  // Longitud máxima
  north: number; // Latitud máxima
}

/**
 * Volumen de edificio de fallback cuando OpenStreetMap carece de etiquetas building:levels / height
 * en polígonos industriales o zonas residenciales periféricas.
 */
export interface FallbackBuildingFootprint {
  id: string;
  label: string;
  lon: number;
  lat: number;
  widthMeters: number;
  depthMeters: number;
  heightMeters: number;
  headingDeg: number;
}

/**
 * Definición de una zona municipal del mundo abierto.
 * Cumple la estructura requerida: { desbloqueada, boundingBox, requisito } + metadatos GIS/narrativos.
 */
export interface ZoneDefinition {
  id: ZoneId;
  nombre: string;
  descripcion: string;
  desbloqueada: boolean;
  boundingBox: GeoBoundingBox;
  requisito: string | null;
  mensajeBloqueo: string;
  puntoInspeccion: {
    lon: number;
    lat: number;
    height: number;
    headingDeg: number;
    pitchDeg: number;
  };
  colorHex: string;
  adyacentes: ZoneId[];
  coberturaOsmNota: string;
  fallbackFootprints: FallbackBuildingFootprint[];
}

/**
 * Mapa indexado de las 5 zonas del juego.
 */
export type ZonesMap = Record<ZoneId, ZoneDefinition>;

/**
 * Perfil de hardware estimado para limitar cacheBytes / maximumMemoryUsage.
 */
export interface HardwareMemoryProfile {
  tier: 'INTEGRATED_GPU' | 'DEDICATED_GPU';
  rendererInfo: string;
  totalCacheMB: number;
  activeZoneCacheBytes: number;
  preloadZoneCacheBytes: number;
  defaultMaximumScreenSpaceError: number;
}

/**
 * Mensajes enviados desde el hilo principal hacia el Web Worker de zonas.
 */
export type WorkerInboundMessage =
  | {
      type: 'INIT_ZONES';
      zones: ZonesMap;
    }
  | {
      type: 'CHECK_POSITION';
      lon: number;
      lat: number;
      prevLon: number;
      prevLat: number;
      vxMetersPerSec: number;
      vyMetersPerSec: number;
      isSpectator: boolean;
      timestamp: number;
    }
  | {
      type: 'SET_ZONE_UNLOCK';
      zoneId: ZoneId;
      desbloqueada: boolean;
    };

/**
 * Respuesta calculada por el Web Worker sin bloquear el hilo de render.
 */
export interface WorkerSpatialEvaluation {
  type: 'SPATIAL_EVALUATION';
  currentZone: ZoneId | null;
  blockedAttemptZone: ZoneId | null;
  mensajeDiegetico: string | null;
  requisitoPendiente: string | null;
  clampedLon: number;
  clampedLat: number;
  wasClamped: boolean;
  preloadCandidateZone: ZoneId | null;
  distanceToPreloadBorderMeters: number | null;
  timestamp: number;
}

export type WorkerOutboundMessage =
  | WorkerSpatialEvaluation
  | {
      type: 'ZONES_UPDATED';
      zones: Record<ZoneId, { desbloqueada: boolean; requisito: string | null }>;
    };
