import * as Cesium from 'cesium';
import { INITIAL_PLAYER_SPAWN, INITIAL_ZONES_CONFIG } from '../config/zones.config';
import { WorkerSpatialEvaluation, ZoneId } from '../types/zones';
import { ZoneManager } from './ZoneManager';

const METERS_PER_DEG_LAT = 111132.0;
const METERS_PER_DEG_LON = 111320.0 * Math.cos((43.28 * Math.PI) / 180.0);

/**
 * PLAYER CONTROLLER & MODO ESPECTADOR
 * -----------------------------------
 * - En Modo Jugador (3ª Persona): Controla el avatar dinámico (única instancia de Cesium.Entity
 *   en toda la escena, reservada para objetos dinámicos), aplica seguimiento de terreno,
 *   calcula el vector velocidad en m/s para la precarga predictiva y aplica la barrera lógica
 *   cuando el Web Worker detecta intento de cruce a un municipio bloqueado.
 * - En Modo Espectador (Free-Fly GIS): Libera la cámara para volar por todo el Gran Bilbao,
 *   con controles WASD + Espacio/Ctrl y teletransporte aéreo directo a los 5 municipios.
 */
export class PlayerController {
  private viewer: Cesium.Viewer;
  private zoneManager: ZoneManager;

  // Estado cinemático del jugador
  private lon = INITIAL_PLAYER_SPAWN.lon;
  private lat = INITIAL_PLAYER_SPAWN.lat;
  private prevLon = INITIAL_PLAYER_SPAWN.lon;
  private prevLat = INITIAL_PLAYER_SPAWN.lat;
  private groundHeight = INITIAL_PLAYER_SPAWN.height;
  private headingRad = Cesium.Math.toRadians(INITIAL_PLAYER_SPAWN.headingDeg);

  // Cámara orbital en 3ª persona
  private cameraPitchRad = Cesium.Math.toRadians(-24.0);
  private cameraDistance = 68.0;

  // Velocidades en m/s
  private vxMetersPerSec = 0;
  private vyMetersPerSec = 0;
  private baseSpeedMetersPerSec = 32.0; // ~115 km/h velocidad de vehículo urbano ágil para recorrer municipios
  private sprintMultiplier = 2.8;

  // Modo Espectador
  private spectatorMode = false;
  private spectatorSpeedMetersPerSec = 260.0;

  // Input de teclado y ratón
  private keysPressed = new Set<string>();
  private isDraggingMouse = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  // Única Entity dinámica del juego (Avatar del Jugador)
  private playerEntity: Cesium.Entity;

  // Callback para actualizar el HUD
  private onHudUpdate?: (state: {
    isSpectator: boolean;
    lon: number;
    lat: number;
    speedMetersPerSec: number;
    headingDeg: number;
  }) => void;

  constructor(
    viewer: Cesium.Viewer,
    zoneManager: ZoneManager,
    onHudUpdate?: (state: {
      isSpectator: boolean;
      lon: number;
      lat: number;
      speedMetersPerSec: number;
      headingDeg: number;
    }) => void
  ) {
    this.viewer = viewer;
    this.zoneManager = zoneManager;
    this.onHudUpdate = onHudUpdate;

    this.playerEntity = this.createDynamicPlayerEntity();
    this.setupInputListeners();
    this.updateThirdPersonCamera();
  }

  /**
   * Crea la única instancia de Cesium.Entity de la escena para el vehículo/avatar dinámico del jugador.
   * El resto de elementos masivos o estáticos usan Cesium.Primitive para 1 sola draw call.
   */
  private createDynamicPlayerEntity(): Cesium.Entity {
    return this.viewer.entities.add({
      id: 'dynamic_player_avatar',
      name: 'Jugador (Vehículo Urbano)',
      position: new Cesium.CallbackProperty(() => {
        return Cesium.Cartesian3.fromDegrees(this.lon, this.lat, this.groundHeight + 2.2);
      }, false) as unknown as Cesium.PositionProperty,
      orientation: new Cesium.CallbackProperty(() => {
        const position = Cesium.Cartesian3.fromDegrees(
          this.lon,
          this.lat,
          this.groundHeight + 2.2
        );
        const hpr = new Cesium.HeadingPitchRoll(this.headingRad, 0, 0);
        return Cesium.Transforms.headingPitchRollQuaternion(position, hpr);
      }, false),
      box: {
        dimensions: new Cesium.Cartesian3(4.8, 2.2, 1.8),
        material: Cesium.Color.fromCssColorString('#00e5ff'),
        outline: true,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
      },
      point: {
        pixelSize: 10,
        color: Cesium.Color.fromCssColorString('#00e676'),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private setupInputListeners(): void {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Tab') {
        e.preventDefault();
        this.toggleSpectatorMode();
        return;
      }
      this.keysPressed.add(e.code);
    });

    window.addEventListener('keyup', (e) => {
      this.keysPressed.delete(e.code);
    });

    const canvas = this.viewer.scene.canvas;
    canvas.addEventListener('mousedown', (e) => {
      if (!this.spectatorMode && e.button === 0) {
        this.isDraggingMouse = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
      }
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.spectatorMode && this.isDraggingMouse) {
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        this.headingRad += dx * 0.005;
        this.cameraPitchRad = Cesium.Math.clamp(
          this.cameraPitchRad - dy * 0.004,
          Cesium.Math.toRadians(-65),
          Cesium.Math.toRadians(-10)
        );
      }
    });

    window.addEventListener('mouseup', () => {
      this.isDraggingMouse = false;
    });

    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.spectatorMode) {
          this.cameraDistance = Cesium.Math.clamp(
            this.cameraDistance + e.deltaY * 0.08,
            25.0,
            260.0
          );
        }
      },
      { passive: true }
    );
  }

  /**
   * Alterna entre el Modo Jugador (3ª Persona con barreras de zona) y el Modo Espectador
   * (cámara libre aérea para inspeccionar todo el mapa de Bizkaia).
   */
  public toggleSpectatorMode(forceState?: boolean): boolean {
    const nextState = forceState !== undefined ? forceState : !this.spectatorMode;
    if (this.spectatorMode === nextState) return this.spectatorMode;

    this.spectatorMode = nextState;

    const controller = this.viewer.scene.screenSpaceCameraController;
    if (this.spectatorMode) {
      // Desvincular la cámara del transform local del jugador
      this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      controller.enableRotate = true;
      controller.enableTranslate = true;
      controller.enableZoom = true;
      controller.enableTilt = true;
      controller.enableLook = true;

      // Elevar suavemente la cámara para dar perspectiva de espectador sobre la posición actual
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          this.lon,
          this.lat - 0.008,
          Math.max(this.groundHeight + 420, 420)
        ),
        orientation: {
          heading: this.headingRad,
          pitch: Cesium.Math.toRadians(-35),
          roll: 0,
        },
        duration: 1.1,
      });
    } else {
      // Volver a anclar la cámara al vehículo del jugador en 3ª persona
      controller.enableRotate = false;
      controller.enableTranslate = false;
      controller.enableZoom = false;
      controller.enableTilt = false;
      controller.enableLook = false;
      this.updateThirdPersonCamera();
    }

    return this.spectatorMode;
  }

  /**
   * Vuela directamente a cualquiera de los 5 municipios o a la vista general metropolitana
   * activando automáticamente el Modo Espectador.
   */
  public flyToZoneInspection(target: ZoneId | 'overview'): void {
    this.toggleSpectatorMode(true);

    if (target === 'overview') {
      this.viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(-2.965, 43.215, 11500),
        orientation: {
          heading: Cesium.Math.toRadians(350),
          pitch: Cesium.Math.toRadians(-48),
          roll: 0,
        },
        duration: 1.6,
      });
      return;
    }

    const zone = INITIAL_ZONES_CONFIG[target];
    if (!zone) return;

    // Activar el tileset del municipio inspeccionado para ver sus edificios OSM + fallback
    void this.zoneManager.activateZone(target);

    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        zone.puntoInspeccion.lon,
        zone.puntoInspeccion.lat,
        zone.puntoInspeccion.height
      ),
      orientation: {
        heading: Cesium.Math.toRadians(zone.puntoInspeccion.headingDeg),
        pitch: Cesium.Math.toRadians(zone.puntoInspeccion.pitchDeg),
        roll: 0,
      },
      duration: 1.5,
    });
  }

  /**
   * Bucle de actualización por frame (dt en segundos).
   */
  public update(dt: number): void {
    const safeDt = Math.min(dt, 0.1);

    if (this.spectatorMode) {
      this.updateSpectatorFlight(safeDt);
      return;
    }

    // Rotación de cámara con Q / E o flechas Izquierda / Derecha
    const turnRate = 1.85;
    if (this.keysPressed.has('KeyQ') || this.keysPressed.has('ArrowLeft')) {
      this.headingRad -= turnRate * safeDt;
    }
    if (this.keysPressed.has('KeyE') || this.keysPressed.has('ArrowRight')) {
      this.headingRad += turnRate * safeDt;
    }

    // Vector de entrada WASD relativo al rumbo (headingRad: 0 = Norte, PI/2 = Este)
    let forwardInput = 0;
    let strafeInput = 0;

    if (this.keysPressed.has('KeyW') || this.keysPressed.has('ArrowUp')) forwardInput += 1;
    if (this.keysPressed.has('KeyS') || this.keysPressed.has('ArrowDown')) forwardInput -= 1;
    if (this.keysPressed.has('KeyD')) strafeInput += 1;
    if (this.keysPressed.has('KeyA')) strafeInput -= 1;

    const isSprinting =
      this.keysPressed.has('ShiftLeft') || this.keysPressed.has('ShiftRight');
    const maxSpeed =
      this.baseSpeedMetersPerSec * (isSprinting ? this.sprintMultiplier : 1.0);

    if (forwardInput !== 0 || strafeInput !== 0) {
      const norm = Math.hypot(forwardInput, strafeInput);
      const f = forwardInput / norm;
      const s = strafeInput / norm;

      const sinH = Math.sin(this.headingRad);
      const cosH = Math.cos(this.headingRad);

      // Componente Este (X) y Norte (Y) en metros/segundo
      this.vxMetersPerSec = (f * sinH + s * cosH) * maxSpeed;
      this.vyMetersPerSec = (f * cosH - s * sinH) * maxSpeed;

      this.prevLon = this.lon;
      this.prevLat = this.lat;

      this.lon += (this.vxMetersPerSec * safeDt) / METERS_PER_DEG_LON;
      this.lat += (this.vyMetersPerSec * safeDt) / METERS_PER_DEG_LAT;
    } else {
      this.vxMetersPerSec = 0;
      this.vyMetersPerSec = 0;
    }

    // Ajuste de altura al terreno de Cesium World Terrain
    const carto = Cesium.Cartographic.fromDegrees(this.lon, this.lat);
    const sampledHeight = this.viewer.scene.globe.getHeight(carto);
    if (sampledHeight !== undefined && !Number.isNaN(sampledHeight)) {
      this.groundHeight = Cesium.Math.lerp(this.groundHeight, Math.max(0, sampledHeight), 0.25);
    }

    this.updateThirdPersonCamera();

    // Enviar posición y velocidad al Web Worker a través de ZoneManager
    this.zoneManager.evaluatePlayerPosition(
      this.lon,
      this.lat,
      this.prevLon,
      this.prevLat,
      this.vxMetersPerSec,
      this.vyMetersPerSec,
      false
    );

    const speed = Math.hypot(this.vxMetersPerSec, this.vyMetersPerSec);
    const headingDeg =
      ((Cesium.Math.toDegrees(this.headingRad) % 360) + 360) % 360;

    this.onHudUpdate?.({
      isSpectator: false,
      lon: this.lon,
      lat: this.lat,
      speedMetersPerSec: speed,
      headingDeg,
    });
  }

  /**
   * Vuelo libre 6-DOF cuando el usuario activa el Modo Espectador.
   */
  private updateSpectatorFlight(dt: number): void {
    const cam = this.viewer.camera;
    const isFast =
      this.keysPressed.has('ShiftLeft') || this.keysPressed.has('ShiftRight');
    const step = this.spectatorSpeedMetersPerSec * (isFast ? 3.0 : 1.0) * dt;

    if (this.keysPressed.has('KeyW') || this.keysPressed.has('ArrowUp')) {
      cam.moveForward(step);
    }
    if (this.keysPressed.has('KeyS') || this.keysPressed.has('ArrowDown')) {
      cam.moveBackward(step);
    }
    if (this.keysPressed.has('KeyA') || this.keysPressed.has('ArrowLeft')) {
      cam.moveLeft(step);
    }
    if (this.keysPressed.has('KeyD') || this.keysPressed.has('ArrowRight')) {
      cam.moveRight(step);
    }
    if (this.keysPressed.has('Space')) {
      cam.moveUp(step * 0.75);
    }
    if (this.keysPressed.has('ControlLeft') || this.keysPressed.has('KeyC')) {
      cam.moveDown(step * 0.75);
    }

    const carto = cam.positionCartographic;
    const camLon = Cesium.Math.toDegrees(carto.longitude);
    const camLat = Cesium.Math.toDegrees(carto.latitude);
    const headingDeg =
      ((Cesium.Math.toDegrees(cam.heading) % 360) + 360) % 360;

    // En modo espectador evaluamos la posición bajo la cámara sin bloqueo de barrera (isSpectator = true)
    this.zoneManager.evaluatePlayerPosition(camLon, camLat, camLon, camLat, 0, 0, true);

    this.onHudUpdate?.({
      isSpectator: true,
      lon: camLon,
      lat: camLat,
      speedMetersPerSec: 0,
      headingDeg,
    });
  }

  /**
   * Aplica la corrección de posición devuelta por el Web Worker cuando el jugador
   * choca contra la barrera lógica de una zona bloqueada.
   */
  public applyWorkerEvaluation(evalResult: WorkerSpatialEvaluation): void {
    if (!this.spectatorMode && evalResult.wasClamped) {
      this.lon = evalResult.clampedLon;
      this.lat = evalResult.clampedLat;
      this.updateThirdPersonCamera();
    }
  }

  private updateThirdPersonCamera(): void {
    const targetPosition = Cesium.Cartesian3.fromDegrees(
      this.lon,
      this.lat,
      this.groundHeight + 3.0
    );
    const transform = Cesium.Transforms.eastNorthUpToFixedFrame(targetPosition);
    const offset = new Cesium.HeadingPitchRange(
      this.headingRad,
      this.cameraPitchRad,
      this.cameraDistance
    );
    this.viewer.camera.lookAtTransform(transform, offset);
  }

  public isSpectator(): boolean {
    return this.spectatorMode;
  }

  public getPlayerEntity(): Cesium.Entity {
    return this.playerEntity;
  }
}
