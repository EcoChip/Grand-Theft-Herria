import { HardwareMemoryProfile } from '../types/zones';
import { ZoneManager, ZoneTransitionReport } from './ZoneManager';

/**
 * TELEMETRY MONITOR
 * -----------------
 * Monitoriza FPS, tiempo de cuadro (ms), memoria JS Heap (performance.memory) y uso de VRAM
 * de Cesium3DTileset, registrando eventos detallados en cada transición de zona.
 */
export class TelemetryMonitor {
  private zoneManager: ZoneManager;

  private frameCount = 0;
  private lastSampleTime = performance.now();
  private currentFps = 60;
  private currentFrameMs = 16.6;

  // Referencias al DOM
  private elFps: HTMLElement | null;
  private elGpuTier: HTMLElement | null;
  private elVram: HTMLElement | null;
  private elHeap: HTMLElement | null;
  private elTiles: HTMLElement | null;
  private elSse: HTMLElement | null;
  private elLogList: HTMLElement | null;

  constructor(zoneManager: ZoneManager, hardwareProfile: HardwareMemoryProfile) {
    this.zoneManager = zoneManager;

    this.elFps = document.getElementById('tel-fps');
    this.elGpuTier = document.getElementById('tel-gpu-tier');
    this.elVram = document.getElementById('tel-vram');
    this.elHeap = document.getElementById('tel-heap');
    this.elTiles = document.getElementById('tel-tiles');
    this.elSse = document.getElementById('tel-sse');
    this.elLogList = document.getElementById('tel-transition-log');

    if (this.elGpuTier) {
      const label =
        hardwareProfile.tier === 'DEDICATED_GPU' ? 'Dedicada' : 'Integrada';
      this.elGpuTier.textContent = `${label} (${hardwareProfile.totalCacheMB} MB)`;
      this.elGpuTier.title = hardwareProfile.rendererInfo;
    }
  }

  public tick(): void {
    this.frameCount++;
    const now = performance.now();
    const elapsed = now - this.lastSampleTime;

    if (elapsed >= 500) {
      this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
      this.currentFrameMs = Number((elapsed / this.frameCount).toFixed(1));
      this.frameCount = 0;
      this.lastSampleTime = now;

      this.refreshDomMetrics();
    }
  }

  private refreshDomMetrics(): void {
    const metrics = this.zoneManager.getStreamingMetrics();

    if (this.elFps) {
      this.elFps.textContent = `${this.currentFps} FPS (${this.currentFrameMs}ms)`;
      this.elFps.style.color =
        this.currentFps >= 45 ? '#00e676' : this.currentFps >= 28 ? '#ffab00' : '#ff5252';
    }

    if (this.elVram) {
      this.elVram.textContent = `${metrics.vramMB} MB`;
    }

    const perfMemory = (
      performance as unknown as {
        memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
      }
    ).memory;

    if (this.elHeap) {
      if (perfMemory) {
        const usedMB = (perfMemory.usedJSHeapSize / (1024 * 1024)).toFixed(1);
        this.elHeap.textContent = `${usedMB} MB`;
      } else {
        this.elHeap.textContent = 'N/D (API Std)';
      }
    }

    if (this.elTiles) {
      this.elTiles.textContent = `${metrics.tilesLoaded} / ${metrics.tilesPending}`;
    }

    if (this.elSse) {
      this.elSse.textContent = `${metrics.activeSSE}`;
    }
  }

  /**
   * Registra en el HUD y en consola las estadísticas de FPS y memoria durante una transición de zona.
   */
  public logTransition(report: ZoneTransitionReport): void {
    const heapStr = report.heapMB !== null ? `${report.heapMB}MB Heap` : 'Heap N/D';
    const summaryLine = `[${report.timestamp}] [${report.event}] FPS:${this.currentFps} | VRAM:${report.vramMB}MB | ${heapStr} -> ${report.details}`;

    console.info(`%c${summaryLine}`, 'color: #00e5ff; font-weight: bold;');

    if (this.elLogList) {
      const li = document.createElement('li');
      li.textContent = summaryLine;
      this.elLogList.prepend(li);

      while (this.elLogList.children.length > 15) {
        this.elLogList.removeChild(this.elLogList.lastChild!);
      }
    }
  }
}
