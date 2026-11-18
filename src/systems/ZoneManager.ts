import * as Cesium from 'cesium';
import {
  HardwareMemoryProfile,
  WorkerInboundMessage,
  WorkerOutboundMessage,
  WorkerSpatialEvaluation,
  ZoneId,
  ZonesMap,
} from '../types/zones';
import { INITIAL_ZONES_CONFIG } from '../config/zones.config';

const OSM_BUILDINGS_ASSET_ID = 96188;

export interface ZoneTransitionReport {
  timestamp: string;
  event: 'ACTIVATE' | 'DESTROY' | 'PRELOAD_START' | 'PRELOAD_CANCEL' | 'PROMOTE_PRELOAD';
  fromZone: ZoneId | null;
  toZone: ZoneId | null;
  vramMB: number;
  heapMB: number | null;
  details: string;
}

/**
 * ZONE MANAGER
 * ------------
 * Gestiona el ciclo de vida de los Cesium3DTilesets por zona (activación, precarga predictiva
 * de baja prioridad, promoción y destrucción explícita con destroy() para liberar VRAM),
 * las primitivas estáticas fusionadas (1 sola draw call mediante GeometryInstance batching)
 * y la sincronización con el Web Worker de barreras lógicas y flags de desbloqueo.
 */
export class ZoneManager {
  private viewer: Cesium.Viewer;
  private hardwareProfile: HardwareMemoryProfile;
  private zones: ZonesMap;
  private worker: Worker;

  // Un Cesium3DTileset activo para la zona actual y uno opcional en precarga de baja prioridad
  private activeZoneId: ZoneId | null = null;
  private activeTileset: Cesium.Cesium3DTileset | null = null;

  private preloadZoneId: ZoneId | null = null;
  private preloadTileset: Cesium.Cesium3DTileset | null = null;

  // Tokens de cancelación para cargas asíncronas en vuelo si el jugador cambia rápido de rumbo
  private activeLoadGeneration = 0;
  private preloadLoadGeneration = 0;

  private currentMaximumSSE: number;

  // Primitivas fusionadas (1 draw call para todos los límites de zona, 1 draw call para edificios fallback)
  private boundariesPrimitive: Cesium.Primitive | null = null;
  private fallbackBuildingsPrimitive: Cesium.Primitive | null = null;
  private labelCollection: Cesium.LabelCollection | null = null;
  private fallbackVisible = true;

  // Callbacks hacia el HUD / PlayerController
  private onSpatialEvaluationCallback?: (evalResult: WorkerSpatialEvaluation) => void;
  private onTransitionReportCallback?: (report: ZoneTransitionReport) => void;
  private onZonesStateChangedCallback?: (zones: ZonesMap) => void;

  constructor(
    viewer: Cesium.Viewer,
    hardwareProfile: HardwareMemoryProfile,
    onSpatialEvaluation?: (evalResult: WorkerSpatialEvaluation) => void,
    onTransitionReport?: (report: ZoneTransitionReport) => void,
    onZonesStateChanged?: (zones: ZonesMap) => void
  ) {
    this.viewer = viewer;
    this.hardwareProfile = hardwareProfile;
    this.zones = structuredClone(INITIAL_ZONES_CONFIG);
    this.currentMaximumSSE = hardwareProfile.defaultMaximumScreenSpaceError;

    this.onSpatialEvaluationCallback = onSpatialEvaluation;
    this.onTransitionReportCallback = onTransitionReport;
    this.onZonesStateChangedCallback = onZonesStateChanged;

    // Inicializar Web Worker para comprobación de límites y estado de desbloqueo
    this.worker = new Worker(new URL('../workers/zoneWorker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (e: MessageEvent<WorkerOutboundMessage>) => {
      this.handleWorkerMessage(e.data);
    };

    const initMsg: WorkerInboundMessage = {
      type: 'INIT_ZONES',
      zones: this.zones,
    };
    this.worker.postMessage(initMsg);
  }

  /**
   * Inicializa la geometría estática fusionada (Primitive API) y carga el tileset de la zona inicial.
   */
  public async initialize(initialZone: ZoneId = 'bilbao'): Promise<void> {
    this.buildBatchedZoneBoundariesPrimitive();
    this.buildBatchedFallbackBuildingsPrimitive();
    this.buildZoneStaticLabels();
    await this.activateZone(initialZone);
  }

  /**
   * Construye los perímetros y barreras visuales de los 5 municipios fusionados en UN SOLO Cesium.Primitive
   * para garantizar 1 única draw call estática en lugar de usar múltiples Entities.
   */
  private buildBatchedZoneBoundariesPrimitive(): void {
    const instances: Cesium.GeometryInstance[] = [];

    for (const zone of Object.values(this.zones)) {
      const { west, south, east, north } = zone.boundingBox;
      const positions = Cesium.Cartesian3.fromDegreesArray([
        west, south,
        east, south,
        east, north,
        west, north,
        west, south,
      ]);

      // Las zonas bloqueadas muestran una barrera translúcida roja/ámbar; las desbloqueadas un borde verde suave
      const baseColor = zone.desbloqueada
        ? Cesium.Color.fromCssColorString('#00e676').withAlpha(0.14)
        : Cesium.Color.fromCssColorString('#ff5252').withAlpha(0.32);

      const wallGeometry = new Cesium.WallGeometry({
        positions,
        maximumHeights: [85, 85, 85, 85, 85],
        minimumHeights: [-15, -15, -15, -15, -15],
      });

      instances.push(
        new Cesium.GeometryInstance({
          id: `zone_barrier_${zone.id}`,
          geometry: wallGeometry,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(baseColor),
          },
        })
      );
    }

    this.boundariesPrimitive = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: true,
      }),
      asynchronous: false,
    });

    this.viewer.scene.primitives.add(this.boundariesPrimitive);
  }

  /**
   * Construye los volúmenes 3D de fallback (naves industriales de Basauri, terminales del Superpuerto
   * de Santurtzi, estación de cruceros de Getxo, pórtico de Portugalete) fusionados en UN SOLO
   * Cesium.Primitive (1 sola draw call) para cubrir carencias de altura en OpenStreetMap.
   */
  private buildBatchedFallbackBuildingsPrimitive(): void {
    const instances: Cesium.GeometryInstance[] = [];

    for (const zone of Object.values(this.zones)) {
      const zoneColor = Cesium.Color.fromCssColorString(zone.colorHex).withAlpha(0.78);

      for (const fp of zone.fallbackFootprints) {
        const center = Cesium.Cartesian3.fromDegrees(fp.lon, fp.lat, fp.heightMeters / 2 + 8);
        const hpr = new Cesium.HeadingPitchRoll(Cesium.Math.toRadians(fp.headingDeg), 0, 0);
        const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(center, hpr);

        const boxGeometry = Cesium.BoxGeometry.fromDimensions({
          dimensions: new Cesium.Cartesian3(fp.widthMeters, fp.depthMeters, fp.heightMeters),
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
        });

        instances.push(
          new Cesium.GeometryInstance({
            id: fp.id,
            geometry: boxGeometry,
            modelMatrix,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(zoneColor),
            },
          })
        );
      }
    }

    if (instances.length > 0) {
      this.fallbackBuildingsPrimitive = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: false,
          translucent: true,
        }),
        asynchronous: false,
        show: this.fallbackVisible,
      });
      this.viewer.scene.primitives.add(this.fallbackBuildingsPrimitive);
    }
  }

  /**
   * Crea etiquetas geográficas de bajo coste mediante LabelCollection (Primitive de bajo nivel)
   * en lugar de Entities individuales.
   */
  private buildZoneStaticLabels(): void {
    this.labelCollection = new Cesium.LabelCollection();
    for (const zone of Object.values(this.zones)) {
      const centerLon = (zone.boundingBox.west + zone.boundingBox.east) / 2;
      const centerLat = (zone.boundingBox.south + zone.boundingBox.north) / 2;
      const statusText = zone.desbloqueada ? 'ABIERTA' : `BLOQUEADA [${zone.requisito}]`;

      this.labelCollection.add({
        id: zone.id,
        position: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, 130),
        text: `${zone.nombre.toUpperCase()}\n${statusText}`,
        font: '700 13px Inter, sans-serif',
        fillColor: zone.desbloqueada
          ? Cesium.Color.fromCssColorString('#00e676')
          : Cesium.Color.fromCssColorString('#ff5252'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 28000.0),
      });
    }
    this.viewer.scene.primitives.add(this.labelCollection);
  }

  /**
   * Crea y configura un Cesium3DTileset de Cesium OSM Buildings acotado y estilizado para una zona.
   * Distingue entre carga activa (alta prioridad) y precarga adyacente (baja prioridad).
   */
  private async createZoneTileset(
    zoneId: ZoneId,
    isPreload: boolean
  ): Promise<Cesium.Cesium3DTileset> {
    const zone = this.zones[zoneId];
    const { west, south, east, north } = zone.boundingBox;

    // Presupuesto de memoria (cacheBytes) y SSE según si es zona activa o precarga de baja prioridad
    const cacheBytes = isPreload
      ? this.hardwareProfile.preloadZoneCacheBytes
      : this.hardwareProfile.activeZoneCacheBytes;

    const maximumScreenSpaceError = isPreload
      ? Math.min(64, this.currentMaximumSSE * 3) // Baja prioridad en precarga: mayor SSE = menos carga de red
      : this.currentMaximumSSE;

    const tileset = await Cesium.Cesium3DTileset.fromIonAssetId(OSM_BUILDINGS_ASSET_ID, {
      maximumScreenSpaceError,
      cacheBytes,
      maximumCacheOverflowBytes: Math.floor(cacheBytes * 0.25),
      // Optimizaciones de streaming y frustum/movement culling
      cullWithChildrenBounds: true,
      cullRequestsWhileMoving: true,
      cullRequestsWhileMovingMultiplier: isPreload ? 140.0 : 60.0,
      foveatedScreenSpaceError: true,
      foveatedConeSize: 0.1,
      foveatedMinimumScreenSpaceErrorRelaxation: 0.0,
      preloadWhenHidden: isPreload,
      preferLeaves: !isPreload,
      dynamicScreenSpaceError: true,
      dynamicScreenSpaceErrorDensity: 0.00278,
      dynamicScreenSpaceErrorFactor: 4.0,
    });

    // Compatibilidad adicional con versiones que leen maximumMemoryUsage (en MB)
    const legacyTileset = tileset as unknown as { maximumMemoryUsage?: number };
    if ('maximumMemoryUsage' in legacyTileset) {
      legacyTileset.maximumMemoryUsage = Math.floor(cacheBytes / (1024 * 1024));
    }

    // Filtrado espacial de los edificios OSM dentro del BoundingBox del municipio correspondiente
    // con margen perimetral de ~150m (0.0015°) para evitar cortes bruscos en calles limítrofes.
    const pad = 0.0015;
    const w = west - pad;
    const e = east + pad;
    const s = south - pad;
    const n = north + pad;

    tileset.style = new Cesium.Cesium3DTileStyle({
      show: {
        conditions: [
          [
            `\${feature['cesium#longitude']} !== undefined && \${feature['cesium#latitude']} !== undefined`,
            `\${feature['cesium#longitude']} >= ${w} && \${feature['cesium#longitude']} <= ${e} && \${feature['cesium#latitude']} >= ${s} && \${feature['cesium#latitude']} <= ${n}`,
          ],
          ['true', 'true'],
        ],
      },
      color: {
        conditions: [
          [
            `\${feature['cesium#estimatedHeight']} !== undefined && \${feature['cesium#estimatedHeight']} > 45`,
            `color('#d0e8ff')`,
          ],
          [
            `\${feature['building']} === 'industrial' || \${feature['building']} === 'warehouse'`,
            `color('#cbd5e1')`,
          ],
          ['true', `color('#e2e8f0')`],
        ],
      },
    });

    return tileset;
  }

  /**
   * Destruye explícitamente un Cesium3DTileset y libera su memoria GPU / WebGL.
   */
  private destroyTilesetInstance(tileset: Cesium.Cesium3DTileset | null): void {
    if (!tileset) return;
    // scene.primitives.remove destruye la primitiva cuando destroyPrimitives === true (por defecto),
    // y verificamos isDestroyed() para invocar destroy() explícitamente si aún sigue viva.
    this.viewer.scene.primitives.remove(tileset);
    if (!tileset.isDestroyed()) {
      tileset.destroy();
    }
  }

  /**
   * Activa la zona indicada:
   * - Si ya estaba precargada en background (preloadTileset), la promueve instantáneamente a activa.
   * - Destruye (destroy()) el tileset de la zona anterior para liberar memoria VRAM.
   */
  public async activateZone(newZoneId: ZoneId): Promise<void> {
    if (this.activeZoneId === newZoneId && this.activeTileset) {
      return;
    }

    const previousZoneId = this.activeZoneId;

    // Caso 1: La nueva zona ya estaba precargada predictivamente -> Promoción sin recarga
    if (this.preloadZoneId === newZoneId && this.preloadTileset) {
      const oldTileset = this.activeTileset;
      this.activeTileset = this.preloadTileset;
      this.activeZoneId = newZoneId;
      this.preloadTileset = null;
      this.preloadZoneId = null;

      // Elevar prioridad y presupuesto de memoria del tileset promovido
      this.activeTileset.maximumScreenSpaceError = this.currentMaximumSSE;
      this.activeTileset.cacheBytes = this.hardwareProfile.activeZoneCacheBytes;
      this.activeTileset.cullRequestsWhileMovingMultiplier = 60.0;

      // Destruir el tileset de la zona abandonada
      if (oldTileset) {
        this.destroyTilesetInstance(oldTileset);
        this.emitTransitionReport(
          'DESTROY',
          previousZoneId,
          newZoneId,
          `Tileset de ${previousZoneId} destruido (destroy() completado)`
        );
      }

      this.emitTransitionReport(
        'PROMOTE_PRELOAD',
        previousZoneId,
        newZoneId,
        `Promovido tileset precargado de ${newZoneId} a activo (SSE=${this.currentMaximumSSE})`
      );
      return;
    }

    // Caso 2: Carga estándar de nueva zona y destrucción de la anterior
    const loadGen = ++this.activeLoadGeneration;
    const oldTileset = this.activeTileset;
    this.activeZoneId = newZoneId;
    this.activeTileset = null;

    if (oldTileset) {
      this.destroyTilesetInstance(oldTileset);
      this.emitTransitionReport(
        'DESTROY',
        previousZoneId,
        newZoneId,
        `Liberada VRAM de ${previousZoneId} al salir de zona`
      );
    }

    try {
      const newTileset = await this.createZoneTileset(newZoneId, false);
      // Si el jugador cambió de zona otra vez mientras se resolvía la promesa, descartar y destruir
      if (loadGen !== this.activeLoadGeneration) {
        if (!newTileset.isDestroyed()) {
          newTileset.destroy();
        }
        return;
      }

      this.activeTileset = newTileset;
      this.viewer.scene.primitives.add(newTileset);

      this.emitTransitionReport(
        'ACTIVATE',
        previousZoneId,
        newZoneId,
        `Activado Cesium3DTileset para ${newZoneId} (SSE=${this.currentMaximumSSE})`
      );
    } catch (err) {
      console.error(`[ZoneManager] Error cargando Cesium3DTileset para ${newZoneId}:`, err);
    }
  }

  /**
   * Inicia o cancela la precarga de baja prioridad de la zona adyacente en la dirección de movimiento.
   */
  private async handlePredictivePreload(candidateZoneId: ZoneId | null): Promise<void> {
    // Si no hay candidato o coincide con la zona activa, cancelar cualquier precarga en curso
    if (!candidateZoneId || candidateZoneId === this.activeZoneId) {
      if (this.preloadZoneId || this.preloadTileset) {
        this.cancelPreload('Jugador cambió de rumbo o detuvo avance hacia zona vecina');
      }
      return;
    }

    // Si ya estamos precargando exactamente esa zona, mantenerla
    if (this.preloadZoneId === candidateZoneId) {
      return;
    }

    // Si estaba precargando otra zona distinta, cancelarla y destruirla antes de precargar la nueva
    if (this.preloadZoneId && this.preloadZoneId !== candidateZoneId) {
      this.cancelPreload(`Rumbo cambiado de ${this.preloadZoneId} hacia ${candidateZoneId}`);
    }

    this.preloadZoneId = candidateZoneId;
    const gen = ++this.preloadLoadGeneration;

    this.emitTransitionReport(
      'PRELOAD_START',
      this.activeZoneId,
      candidateZoneId,
      `Iniciando precarga predictiva de baja prioridad para ${candidateZoneId}`
    );

    try {
      const preloadTileset = await this.createZoneTileset(candidateZoneId, true);
      if (gen !== this.preloadLoadGeneration || this.preloadZoneId !== candidateZoneId) {
        if (!preloadTileset.isDestroyed()) {
          preloadTileset.destroy();
        }
        return;
      }

      this.preloadTileset = preloadTileset;
      this.viewer.scene.primitives.add(preloadTileset);
    } catch (err) {
      console.warn(`[ZoneManager] Precarga cancelada/fallida en ${candidateZoneId}:`, err);
    }
  }

  /**
   * Cancela la precarga adyacente y destruye su Cesium3DTileset para liberar memoria inmediatamente.
   */
  public cancelPreload(reason: string): void {
    this.preloadLoadGeneration++;
    const cancelledZone = this.preloadZoneId;
    this.preloadZoneId = null;

    if (this.preloadTileset) {
      this.destroyTilesetInstance(this.preloadTileset);
      this.preloadTileset = null;
    }

    if (cancelledZone) {
      this.emitTransitionReport('PRELOAD_CANCEL', this.activeZoneId, cancelledZone, reason);
    }
  }

  /**
   * Envía la posición y velocidad actual del jugador al Web Worker para evaluar límites,
   * barreras lógicas de desbloqueo y precarga predictiva sin bloquear el hilo de render.
   */
  public evaluatePlayerPosition(
    lon: number,
    lat: number,
    prevLon: number,
    prevLat: number,
    vxMetersPerSec: number,
    vyMetersPerSec: number,
    isSpectator: boolean
  ): void {
    const msg: WorkerInboundMessage = {
      type: 'CHECK_POSITION',
      lon,
      lat,
      prevLon,
      prevLat,
      vxMetersPerSec,
      vyMetersPerSec,
      isSpectator,
      timestamp: performance.now(),
    };
    this.worker.postMessage(msg);
  }

  /**
   * Procesa las respuestas asíncronas del Web Worker.
   */
  private handleWorkerMessage(msg: WorkerOutboundMessage): void {
    if (msg.type === 'ZONES_UPDATED') {
      for (const zoneId of Object.keys(msg.zones) as ZoneId[]) {
        this.zones[zoneId].desbloqueada = msg.zones[zoneId].desbloqueada;
        this.updateZoneVisualState(zoneId);
      }
      this.onZonesStateChangedCallback?.(this.zones);
      return;
    }

    if (msg.type === 'SPATIAL_EVALUATION') {
      // Si el jugador entró legítimamente en una nueva zona, activar su tileset y destruir el anterior
      if (msg.currentZone && msg.currentZone !== this.activeZoneId) {
        void this.activateZone(msg.currentZone);
      }

      // Gestionar precarga de baja prioridad según el vector de movimiento evaluado en el Worker
      void this.handlePredictivePreload(msg.preloadCandidateZone);

      this.onSpatialEvaluationCallback?.(msg);
    }
  }

  /**
   * Desbloquea o bloquea una zona en caliente (independientemente de si sus 3D Tiles están cargados).
   */
  public setZoneUnlocked(zoneId: ZoneId, desbloqueada: boolean): void {
    this.zones[zoneId].desbloqueada = desbloqueada;
    this.updateZoneVisualState(zoneId);

    const msg: WorkerInboundMessage = {
      type: 'SET_ZONE_UNLOCK',
      zoneId,
      desbloqueada,
    };
    this.worker.postMessage(msg);
  }

  /**
   * Actualiza los atributos de instancia dentro del Cesium.Primitive fusionado sin recrear geometría.
   */
  private updateZoneVisualState(zoneId: ZoneId): void {
    const zone = this.zones[zoneId];
    if (this.boundariesPrimitive) {
      const attrs = this.boundariesPrimitive.getGeometryInstanceAttributes(
        `zone_barrier_${zoneId}`
      );
      if (attrs) {
        const newColor = zone.desbloqueada
          ? Cesium.Color.fromCssColorString('#00e676').withAlpha(0.14)
          : Cesium.Color.fromCssColorString('#ff5252').withAlpha(0.32);
        attrs.color = Cesium.ColorGeometryInstanceAttribute.toValue(newColor);
      }
    }

    if (this.labelCollection) {
      const len = this.labelCollection.length;
      for (let i = 0; i < len; i++) {
        const label = this.labelCollection.get(i);
        if (label.id === zoneId) {
          const statusText = zone.desbloqueada ? 'ABIERTA' : `BLOQUEADA [${zone.requisito}]`;
          label.text = `${zone.nombre.toUpperCase()}\n${statusText}`;
          label.fillColor = zone.desbloqueada
            ? Cesium.Color.fromCssColorString('#00e676')
            : Cesium.Color.fromCssColorString('#ff5252');
          break;
        }
      }
    }
  }

  /**
   * Ajusta en tiempo real el maximumScreenSpaceError para equilibrar calidad y rendimiento.
   */
  public setMaximumScreenSpaceError(sse: number): void {
    this.currentMaximumSSE = sse;
    if (this.activeTileset && !this.activeTileset.isDestroyed()) {
      this.activeTileset.maximumScreenSpaceError = sse;
    }
    if (this.preloadTileset && !this.preloadTileset.isDestroyed()) {
      this.preloadTileset.maximumScreenSpaceError = Math.min(64, sse * 3);
    }
  }

  /**
   * Alterna la visibilidad de los volúmenes fallback de OSM (1 sola draw call).
   */
  public toggleFallbackBuildings(): boolean {
    this.fallbackVisible = !this.fallbackVisible;
    if (this.fallbackBuildingsPrimitive) {
      this.fallbackBuildingsPrimitive.show = this.fallbackVisible;
    }
    return this.fallbackVisible;
  }

  public getZones(): ZonesMap {
    return this.zones;
  }

  public getActiveZoneId(): ZoneId | null {
    return this.activeZoneId;
  }

  public getPreloadZoneId(): ZoneId | null {
    return this.preloadZoneId;
  }

  /**
   * Obtiene métricas agregadas de memoria VRAM y estado de los tilesets activos/precargados.
   */
  public getStreamingMetrics(): {
    vramMB: number;
    tilesLoaded: number;
    tilesPending: number;
    activeSSE: number;
  } {
    let totalBytes = 0;
    let tilesLoaded = 0;
    let tilesPending = 0;

    const inspectTileset = (ts: Cesium.Cesium3DTileset | null) => {
      if (!ts || ts.isDestroyed()) return;
      totalBytes += ts.totalMemoryUsageInBytes || 0;
      const stats = (
        ts as unknown as {
          statistics?: {
            numberOfLoadedTilesTotal?: number;
            numberOfPendingRequests?: number;
            numberOfTilesProcessing?: number;
          };
        }
      ).statistics;
      if (stats) {
        tilesLoaded += stats.numberOfLoadedTilesTotal ?? 0;
        tilesPending +=
          (stats.numberOfPendingRequests ?? 0) + (stats.numberOfTilesProcessing ?? 0);
      }
    };

    inspectTileset(this.activeTileset);
    inspectTileset(this.preloadTileset);

    return {
      vramMB: Number((totalBytes / (1024 * 1024)).toFixed(2)),
      tilesLoaded,
      tilesPending,
      activeSSE: this.currentMaximumSSE,
    };
  }

  private emitTransitionReport(
    event: ZoneTransitionReport['event'],
    fromZone: ZoneId | null,
    toZone: ZoneId | null,
    details: string
  ): void {
    const metrics = this.getStreamingMetrics();
    const perfMemory = (
      performance as unknown as { memory?: { usedJSHeapSize: number } }
    ).memory;
    const heapMB = perfMemory
      ? Number((perfMemory.usedJSHeapSize / (1024 * 1024)).toFixed(1))
      : null;

    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0];

    this.onTransitionReportCallback?.({
      timestamp,
      event,
      fromZone,
      toZone,
      vramMB: metrics.vramMB,
      heapMB,
      details,
    });
  }
}
