import * as Cesium from 'cesium';
import { detectHardwareMemoryProfile } from './systems/HardwareProfiler';
import { ZoneManager } from './systems/ZoneManager';
import { PlayerController } from './systems/PlayerController';
import { TelemetryMonitor } from './systems/TelemetryMonitor';
import { WorkerSpatialEvaluation, ZoneId, ZonesMap } from './types/zones';

/**
 * Token de Cesium ion configurado por entorno (.env) con fallback directo al token proporcionado
 * para desarrollo inmediato del prototipo.
 */
const DEFAULT_CESIUM_ION_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IkExVTRuZUh5RGE3eUlnQTciLCJqdGkiOiIyOTU5NWQ2MS01Y2Q0LTQzZjUtYjI5OC1lZWNiMDU0NWE1NDUiLCJpZCI6NTMxODg5LCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3OTI1OTM2MjJ9.czrcwKX7guX9bIif-_TMzzoCtjfZr-xfny7To8HjuPg';

Cesium.Ion.defaultAccessToken =
  import.meta.env.VITE_CESIUM_ION_TOKEN || DEFAULT_CESIUM_ION_TOKEN;

async function bootstrapBilbaoOpenWorld(): Promise<void> {
  // 1. Inicializar el Viewer de CesiumJS sin widgets superfluos para maximizar rendimiento
  const viewer = new Cesium.Viewer('cesiumContainer', {
    terrain: Cesium.Terrain.fromWorldTerrain({
      requestWaterMask: true,
      requestVertexNormals: true,
    }),
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    vrButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    navigationHelpButton: false,
    requestRenderMode: false, // Bucle continuo para movimiento en tiempo real
    msaaSamples: 2,
  });

  // Ajustes de escena y globo para el entorno topográfico de Bizkaia (ríos, montes y costa)
  viewer.scene.globe.depthTestAgainstTerrain = true;
  viewer.scene.postProcessStages.fxaa.enabled = true;
  if (viewer.scene.skyAtmosphere) {
    viewer.scene.skyAtmosphere.show = true;
  }

  // 2. Detectar perfil de hardware (GPU Integrada 1024 MB vs Dedicada 2048 MB)
  const hardwareProfile = detectHardwareMemoryProfile(viewer.scene.canvas);

  let diegeticBannerTimeout: number | undefined;
  let telemetryMonitor: TelemetryMonitor | null = null;
  let playerController: PlayerController | null = null;

  // 3. Instanciar ZoneManager (gestiona Cesium3DTilesets por zona, Primitive batching y Web Worker)
  const zoneManager = new ZoneManager(
    viewer,
    hardwareProfile,
    (evalResult: WorkerSpatialEvaluation) => {
      playerController?.applyWorkerEvaluation(evalResult);
      updateHudSpatialStatus(evalResult, zoneManager.getZones());

      if (evalResult.wasClamped && evalResult.mensajeDiegetico) {
        showDiegeticBarrierAlert(
          evalResult.blockedAttemptZone,
          evalResult.mensajeDiegetico,
          evalResult.requisitoPendiente,
          zoneManager.getZones()
        );
      }
    },
    (transitionReport) => {
      telemetryMonitor?.logTransition(transitionReport);
    },
    (updatedZones) => {
      renderZoneFlagsPanel(updatedZones, zoneManager);
    }
  );

  // 4. Instanciar TelemetryMonitor y PlayerController
  telemetryMonitor = new TelemetryMonitor(zoneManager, hardwareProfile);

  playerController = new PlayerController(viewer, zoneManager, (playerState) => {
    const elCoords = document.getElementById('hud-coords');
    const elVel = document.getElementById('hud-velocity');
    if (elCoords) {
      elCoords.textContent = `${playerState.lon.toFixed(4)}°, ${playerState.lat.toFixed(4)}°`;
    }
    if (elVel) {
      const cardinal = degreeToCardinal(playerState.headingDeg);
      if (playerState.isSpectator) {
        elVel.textContent = `Vuelo Libre (${Math.round(playerState.headingDeg)}° ${cardinal})`;
      } else {
        const kmh = (playerState.speedMetersPerSec * 3.6).toFixed(0);
        elVel.textContent = `${playerState.speedMetersPerSec.toFixed(1)} m/s (${kmh} km/h · ${cardinal})`;
      }
    }
  });

  // 5. Inicializar zona principal (Bilbao) y primitivas estáticas fusionadas
  await zoneManager.initialize('bilbao');
  renderZoneFlagsPanel(zoneManager.getZones(), zoneManager);
  bindHudControls(zoneManager, playerController, hardwareProfile.defaultMaximumScreenSpaceError);

  // 6. Bucle principal sincronizado con el preUpdate de CesiumJS
  let lastFrameTime = performance.now();
  viewer.scene.preUpdate.addEventListener(() => {
    const now = performance.now();
    const dt = (now - lastFrameTime) / 1000.0;
    lastFrameTime = now;

    playerController?.update(dt);
    telemetryMonitor?.tick();
  });

  function showDiegeticBarrierAlert(
    blockedZoneId: ZoneId | null,
    message: string,
    requisito: string | null,
    zones: ZonesMap
  ): void {
    const banner = document.getElementById('diegetic-banner');
    const titleEl = document.getElementById('diegetic-zone-title');
    const msgEl = document.getElementById('diegetic-message');
    const reqEl = document.getElementById('diegetic-req');

    if (!banner || !titleEl || !msgEl || !reqEl) return;

    const zoneName = blockedZoneId ? zones[blockedZoneId].nombre.toUpperCase() : 'MUNICIPIO';
    titleEl.textContent = `ACCESO BLOQUEADO — ${zoneName}`;
    msgEl.textContent = `«${message}»`;
    reqEl.textContent = `Requisito de progresión pendiente: ${requisito ?? 'N/A'}`;

    banner.classList.remove('hidden');
    if (diegeticBannerTimeout) {
      window.clearTimeout(diegeticBannerTimeout);
    }
    diegeticBannerTimeout = window.setTimeout(() => {
      banner.classList.add('hidden');
    }, 3200);
  }
}

function updateHudSpatialStatus(evalResult: WorkerSpatialEvaluation, zones: ZonesMap): void {
  const elZone = document.getElementById('hud-zone');
  const elPreload = document.getElementById('hud-preload');

  if (elZone) {
    if (evalResult.currentZone) {
      const z = zones[evalResult.currentZone];
      elZone.textContent = `${z.nombre} (${z.desbloqueada ? 'Desbloqueada' : 'Inspección'})`;
      elZone.className = 'highlight-green';
    } else {
      elZone.textContent = 'Corredor Intermunicipal (Tránsito)';
      elZone.className = 'highlight-amber';
    }
  }

  if (elPreload) {
    if (evalResult.preloadCandidateZone) {
      const targetName = zones[evalResult.preloadCandidateZone].nombre;
      const dist = evalResult.distanceToPreloadBorderMeters ?? 0;
      elPreload.textContent = `Precargando ${targetName} (${dist}m)`;
      elPreload.className = 'highlight-cyan';
    } else {
      elPreload.textContent = 'Inactiva (Sin rumbo a frontera)';
      elPreload.className = '';
    }
  }
}

function renderZoneFlagsPanel(zones: ZonesMap, zoneManager: ZoneManager): void {
  const container = document.getElementById('zones-list');
  if (!container) return;
  container.innerHTML = '';

  for (const zone of Object.values(zones)) {
    const row = document.createElement('div');
    row.className = 'zone-item';

    const info = document.createElement('div');
    info.className = 'zone-info';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'zone-name';
    nameSpan.textContent = zone.nombre;

    const metaSpan = document.createElement('span');
    metaSpan.className = 'zone-meta';
    metaSpan.textContent = `Requisito: ${zone.requisito ?? 'ninguno (Hub)'}`;

    info.appendChild(nameSpan);
    info.appendChild(metaSpan);

    const btn = document.createElement('button');
    btn.className = `zone-toggle-btn ${zone.desbloqueada ? 'unlocked' : 'locked'}`;
    btn.textContent = zone.desbloqueada ? '🔓 Desbloqueada' : '🔒 Bloqueada';

    btn.addEventListener('click', () => {
      zoneManager.setZoneUnlocked(zone.id, !zone.desbloqueada);
    });

    row.appendChild(info);
    row.appendChild(btn);
    container.appendChild(row);
  }
}

function bindHudControls(
  zoneManager: ZoneManager,
  playerController: PlayerController,
  initialSSE: number
): void {
  const btnSpectator = document.getElementById('btn-toggle-spectator');
  const btnFallback = document.getElementById('btn-toggle-fallback');
  const elMode = document.getElementById('hud-mode');
  const elHelp = document.getElementById('hud-controls-help');
  const sliderSse = document.getElementById('slider-sse') as HTMLInputElement | null;
  const labelSseVal = document.getElementById('label-sse-val');

  const syncSpectatorUi = (isSpectator: boolean) => {
    if (elMode) {
      elMode.textContent = isSpectator
        ? 'ESPECTADOR (Vuelo Libre GIS)'
        : 'JUGADOR (3ª Persona + Barreras)';
      elMode.className = isSpectator ? 'highlight-amber' : 'highlight-cyan';
    }
    if (btnSpectator) {
      btnSpectator.textContent = isSpectator
        ? '🚗 Volver a Modo Jugador (TAB)'
        : '🎥 Alternar Modo Espectador (TAB)';
      btnSpectator.classList.toggle('spectator-active', isSpectator);
    }
    if (elHelp) {
      elHelp.innerHTML = isSpectator
        ? '<strong>Controles Espectador:</strong> <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Volar | <kbd>Espacio</kbd> Subir | <kbd>Ctrl</kbd> Bajar | <kbd>Shift</kbd> Turbo | Ratón Libre'
        : '<strong>Controles Jugador:</strong> <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> Moverse | <kbd>Shift</kbd> Sprint | <kbd>Q</kbd><kbd>E</kbd> o Ratón: Girar | <kbd>TAB</kbd> Modo Espectador';
    }
  };

  btnSpectator?.addEventListener('click', () => {
    const state = playerController.toggleSpectatorMode();
    syncSpectatorUi(state);
  });

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') {
      window.setTimeout(() => syncSpectatorUi(playerController.isSpectator()), 10);
    }
  });

  btnFallback?.addEventListener('click', () => {
    const visible = zoneManager.toggleFallbackBuildings();
    btnFallback.textContent = `🏗️ Fallback OSM: ${visible ? 'ON' : 'OFF'}`;
  });

  const flyButtons = document.querySelectorAll<HTMLButtonElement>('[data-FlyTo]');
  flyButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-FlyTo') as ZoneId | 'overview';
      playerController.flyToZoneInspection(target);
      syncSpectatorUi(true);
    });
  });

  if (sliderSse && labelSseVal) {
    sliderSse.value = String(initialSSE);
    labelSseVal.textContent = String(initialSSE);
    sliderSse.addEventListener('input', () => {
      const val = Number(sliderSse.value);
      labelSseVal.textContent = String(val);
      zoneManager.setMaximumScreenSpaceError(val);
    });
  }
}

function degreeToCardinal(deg: number): string {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  return dirs[Math.round(deg / 45) % 8];
}

void bootstrapBilbaoOpenWorld();
