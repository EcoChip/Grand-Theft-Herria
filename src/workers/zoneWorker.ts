import {
  GeoBoundingBox,
  WorkerInboundMessage,
  WorkerOutboundMessage,
  ZoneDefinition,
  ZoneId,
  ZonesMap,
} from '../types/zones';

/**
 * WEB WORKER DE LÓGICA ESPACIAL Y PROGRESIÓN DE ZONAS
 * ----------------------------------------------------
 * Desacopla al 100% la comprobación matemática de límites (Bounding Boxes),
 * colisiones con barreras lógicas de progresión y predicción de rumbo del hilo
 * principal de WebGL / CesiumJS.
 */

let zonesState: ZonesMap | null = null;

// Constantes geodésicas aproximadas para la latitud de Bilbao (~43.26° N)
const METERS_PER_DEG_LAT = 111132.0;
const METERS_PER_DEG_LON = 111320.0 * Math.cos((43.28 * Math.PI) / 180.0); // ~81,050 m/grado
const BARRIER_EPSILON_DEG = 0.00018; // ~15-20 metros de margen exterior de seguridad
const PRELOAD_TRIGGER_DISTANCE_METERS = 1600.0; // Distancia al borde para activar precarga predictiva
const PRELOAD_LOOKAHEAD_SECONDS = 35.0; // Horizonte predictivo según vector de velocidad

/**
 * Comprueba si un punto (lon, lat) está dentro de un GeoBoundingBox.
 */
function isInsideBox(lon: number, lat: number, box: GeoBoundingBox): boolean {
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
}

/**
 * Calcula la distancia mínima en metros desde un punto (lon, lat) al borde de un GeoBoundingBox,
 * y el vector unitario hacia el punto más cercano del BoundingBox.
 */
function distanceAndDirectionToBox(
  lon: number,
  lat: number,
  box: GeoBoundingBox
): { distanceMeters: number; dirX: number; dirY: number } {
  const closestLon = Math.max(box.west, Math.min(lon, box.east));
  const closestLat = Math.max(box.south, Math.min(lat, box.north));

  const dxMeters = (closestLon - lon) * METERS_PER_DEG_LON;
  const dyMeters = (closestLat - lat) * METERS_PER_DEG_LAT;
  const dist = Math.hypot(dxMeters, dyMeters);

  if (dist < 1e-5) {
    return { distanceMeters: 0, dirX: 0, dirY: 0 };
  }
  return {
    distanceMeters: dist,
    dirX: dxMeters / dist,
    dirY: dyMeters / dist,
  };
}

/**
 * Empuja una posición que ha penetrado en un BoundingBox bloqueado hacia el borde exterior
 * más cercano, permitiendo deslizamiento tangencial suave a lo largo de la frontera (estilo GTA).
 */
function clampOutsideLockedBox(
  lon: number,
  lat: number,
  prevLon: number,
  prevLat: number,
  box: GeoBoundingBox
): { clampedLon: number; clampedLat: number } {
  // Si la posición previa estaba fuera de la caja, expulsamos por la cara cruzada
  if (!isInsideBox(prevLon, prevLat, box)) {
    let clampedLon = lon;
    let clampedLat = lat;

    if (prevLon < box.west && lon >= box.west) {
      clampedLon = box.west - BARRIER_EPSILON_DEG;
    } else if (prevLon > box.east && lon <= box.east) {
      clampedLon = box.east + BARRIER_EPSILON_DEG;
    }

    if (prevLat < box.south && lat >= box.south) {
      clampedLat = box.south - BARRIER_EPSILON_DEG;
    } else if (prevLat > box.north && lat <= box.north) {
      clampedLat = box.north + BARRIER_EPSILON_DEG;
    }

    return { clampedLon, clampedLat };
  }

  // Fallback si por teletransporte cayó dentro: proyectar a la arista más cercana
  const distWest = Math.abs(lon - box.west);
  const distEast = Math.abs(box.east - lon);
  const distSouth = Math.abs(lat - box.south);
  const distNorth = Math.abs(box.north - lat);
  const minDist = Math.min(distWest, distEast, distSouth, distNorth);

  if (minDist === distWest) return { clampedLon: box.west - BARRIER_EPSILON_DEG, clampedLat: lat };
  if (minDist === distEast) return { clampedLon: box.east + BARRIER_EPSILON_DEG, clampedLat: lat };
  if (minDist === distSouth) return { clampedLon: lon, clampedLat: box.south - BARRIER_EPSILON_DEG };
  return { clampedLon: lon, clampedLat: box.north + BARRIER_EPSILON_DEG };
}

/**
 * Determina qué zona adyacente debe precargarse con baja prioridad según el vector de movimiento
 * actual del jugador. Si el jugador se detiene o cambia de rumbo alejándose de la zona, devuelve null
 * para que ZoneManager cancele la precarga inmediatamente.
 */
function evaluatePredictivePreload(
  lon: number,
  lat: number,
  vxMetersPerSec: number,
  vyMetersPerSec: number,
  currentZoneId: ZoneId | null,
  zones: ZonesMap
): { candidate: ZoneId | null; distanceMeters: number | null } {
  const speed = Math.hypot(vxMetersPerSec, vyMetersPerSec);
  // Si el jugador está prácticamente quieto (< 0.8 m/s), no forzamos precarga predictiva
  if (speed < 0.8) {
    return { candidate: null, distanceMeters: null };
  }

  const velDirX = vxMetersPerSec / speed;
  const velDirY = vyMetersPerSec / speed;

  // Posición proyectada en el futuro según el rumbo actual
  const projectedLon = lon + (vxMetersPerSec * PRELOAD_LOOKAHEAD_SECONDS) / METERS_PER_DEG_LON;
  const projectedLat = lat + (vyMetersPerSec * PRELOAD_LOOKAHEAD_SECONDS) / METERS_PER_DEG_LAT;

  let bestCandidate: ZoneId | null = null;
  let bestScore = Infinity;
  let bestDistance: number | null = null;

  const zoneList = Object.values(zones) as ZoneDefinition[];
  for (const zone of zoneList) {
    if (zone.id === currentZoneId) continue;

    const { distanceMeters, dirX, dirY } = distanceAndDirectionToBox(lon, lat, zone.boundingBox);

    // Si la proyección cae directamente dentro del municipio vecino
    const projectedHitsBox = isInsideBox(projectedLon, projectedLat, zone.boundingBox);

    // Producto escalar entre el vector velocidad del jugador y el vector hacia la zona vecina
    // dot > 0.35 significa que el jugador avanza con rumbo claro hacia esa zona (< ~69 grados de desviación)
    const alignmentDot = velDirX * dirX + velDirY * dirY;

    if (
      projectedHitsBox ||
      (distanceMeters <= PRELOAD_TRIGGER_DISTANCE_METERS && alignmentDot > 0.35)
    ) {
      const effectiveScore = distanceMeters / Math.max(0.35, alignmentDot);
      if (effectiveScore < bestScore) {
        bestScore = effectiveScore;
        bestCandidate = zone.id;
        bestDistance = Math.round(distanceMeters);
      }
    }
  }

  return { candidate: bestCandidate, distanceMeters: bestDistance };
}

self.onmessage = (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;

  if (msg.type === 'INIT_ZONES') {
    zonesState = msg.zones;
    return;
  }

  if (msg.type === 'SET_ZONE_UNLOCK') {
    if (!zonesState) return;
    const targetZone = zonesState[msg.zoneId];
    if (targetZone) {
      targetZone.desbloqueada = msg.desbloqueada;
    }

    const summary = {} as Record<ZoneId, { desbloqueada: boolean; requisito: string | null }>;
    for (const key of Object.keys(zonesState) as ZoneId[]) {
      summary[key] = {
        desbloqueada: zonesState[key].desbloqueada,
        requisito: zonesState[key].requisito,
      };
    }

    const response: WorkerOutboundMessage = {
      type: 'ZONES_UPDATED',
      zones: summary,
    };
    self.postMessage(response);
    return;
  }

  if (msg.type === 'CHECK_POSITION') {
    if (!zonesState) return;

    let finalLon = msg.lon;
    let finalLat = msg.lat;
    let wasClamped = false;
    let currentZone: ZoneId | null = null;
    let blockedAttemptZone: ZoneId | null = null;
    let mensajeDiegetico: string | null = null;
    let requisitoPendiente: string | null = null;

    const allZones = Object.values(zonesState) as ZoneDefinition[];

    for (const zone of allZones) {
      if (isInsideBox(finalLon, finalLat, zone.boundingBox)) {
        if (!zone.desbloqueada && !msg.isSpectator) {
          // ¡Intento de entrada en zona bloqueada! Aplicamos barrera lógica independiente de los tiles
          blockedAttemptZone = zone.id;
          mensajeDiegetico = zone.mensajeBloqueo;
          requisitoPendiente = zone.requisito;

          const clamped = clampOutsideLockedBox(
            finalLon,
            finalLat,
            msg.prevLon,
            msg.prevLat,
            zone.boundingBox
          );
          finalLon = clamped.clampedLon;
          finalLat = clamped.clampedLat;
          wasClamped = true;
        } else {
          currentZone = zone.id;
        }
        break;
      }
    }

    // Si fue expulsado por una barrera, verificamos en qué zona válida quedó situado tras el clamp
    if (wasClamped && !currentZone) {
      for (const zone of allZones) {
        if (
          (zone.desbloqueada || msg.isSpectator) &&
          isInsideBox(finalLon, finalLat, zone.boundingBox)
        ) {
          currentZone = zone.id;
          break;
        }
      }
    }

    // Cálculo de precarga predictiva según el rumbo y velocidad del jugador
    const preload = evaluatePredictivePreload(
      finalLon,
      finalLat,
      msg.vxMetersPerSec,
      msg.vyMetersPerSec,
      currentZone,
      zonesState
    );

    const evaluation: WorkerOutboundMessage = {
      type: 'SPATIAL_EVALUATION',
      currentZone,
      blockedAttemptZone,
      mensajeDiegetico,
      requisitoPendiente,
      clampedLon: finalLon,
      clampedLat: finalLat,
      wasClamped,
      preloadCandidateZone: preload.candidate,
      distanceToPreloadBorderMeters: preload.distanceMeters,
      timestamp: msg.timestamp,
    };

    self.postMessage(evaluation);
  }
};
