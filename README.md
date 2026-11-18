# Gran Bilbao Open-World GIS Prototype (CesiumJS + TypeScript + Vite)

Prototipo técnico de mapa 3D a escala real para un videojuego de mundo abierto estilo GTA ambientado en el **Gran Bilbao (Bizkaia, Euskadi, España)**. Diseñado bajo una arquitectura de **coste cero y licencia libre**, utilizando **CesiumJS**, **Cesium World Terrain** y **Cesium OSM Buildings** (3D Tiles), con streaming controlado por zonas municipales, precarga predictiva según el rumbo del jugador, barreras lógicas procesadas en un **Web Worker** y un **Modo Espectador (Free-Fly GIS)** integrado.

---

## 1. Estructura del Proyecto

```text
eager-bohr/
├── .env                        # Token de acceso de Cesium ion preconfigurado
├── .env.example                # Plantilla de variables de entorno
├── index.html                  # HUD táctico, controles de Modo Espectador y telemetría
├── package.json                # Dependencias mínimas (cesium, vite, typescript)
├── tsconfig.json               # Configuración estricta de TypeScript (ES2022 + WebWorker)
├── vite.config.ts              # Servidor y bundler zero-dep para assets estáticos de Cesium
├── README.md                   # Documentación de arquitectura, riesgos y roadmap
└── src/
    ├── main.ts                 # Inicialización del Viewer, terreno, HUD y ciclo de vida
    ├── style.css               # Estilos del HUD de telemetría, zonas y alertas diegéticas
    ├── vite-env.d.ts           # Tipos de entorno de Vite
    ├── types/
    │   └── zones.ts            # Contratos TypeScript de zonas, Worker y perfiles de GPU
    ├── config/
    │   └── zones.config.ts     # Bounding boxes reales (WGS84), requisitos y fallbacks OSM
    ├── workers/
    │   └── zoneWorker.ts       # Web Worker: colisión con barreras, flags y predicción de rumbo
    └── systems/
        ├── HardwareProfiler.ts # Detección de GPU integrada (1024 MB) vs dedicada (2048 MB)
        ├── ZoneManager.ts      # Gestión de Cesium3DTileset por zona, destroy() y Primitives
        ├── PlayerController.ts # Movimiento en 3ª persona, barreras y Modo Espectador aéreo
        └── TelemetryMonitor.ts # Monitor de FPS, VRAM, JS Heap y logs de transición de zona
```

---

## 2. Instrucciones de Setup y Ejecución

### Requisitos previos
- **Node.js** 18+ y **npm**.

### Instalación y arranque
```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar servidor de desarrollo (http://localhost:5173)
npm run dev

# 3. Compilar para producción y verificar tipos TypeScript
npm run build
```

---

## 3. Cómo Obtener y Configurar el Token de Cesium ion y Límites del Plan Gratuito

### Obtención del Token
1. Crea una cuenta gratuita (plan **Community**) en [https://cesium.com/ion/](https://cesium.com/ion/).
2. Dirígete a la pestaña **Access Tokens** en el panel de control de Cesium ion.
3. Copia tu token con permisos de lectura de assets (`assets:read`) o usa el token ya configurado en el archivo `.env`:
   ```env
   VITE_CESIUM_ION_TOKEN=tu_token_aqui
   ```
4. Asegúrate de que en la pestaña **Asset Depot** estén añadidos a tu cuenta los assets estándar gratuitos:
   - **Cesium World Terrain** (Asset ID `1`)
   - **Cesium OSM Buildings** (Asset ID `96188`)

### Límites del Plan Gratuito (Cesium ion Community)
- **Almacenamiento**: **5 GB** gratuitos para alojar tus propios Tilesets 3D optimizados.
- **Streaming mensual**: **15 GB / mes** de transferencia de datos 3D y terreno.
- **Coste**: **0 €** (sin tarjeta de crédito requerida, uso no comercial / prototipado).

---

## 4. Controles del Prototipo y Modo Espectador

### Modo Jugador (3ª Persona con Barreras de Progresión)
- `W` `A` `S` `D` o Flechas: Desplazamiento por la superficie de Bilbao.
- `Shift`: Sprint / Aceleración.
- `Q` / `E` o **Arrastrar Ratón (Clic Izquierdo)**: Girar rumbo de cámara.
- **Rueda del Ratón**: Ajustar distancia de seguimiento en 3ª persona.
- **Barreras Lógicas**: Si intentas cruzar a **Portugalete**, **Getxo**, **Santurtzi** o **Basauri** mientras están bloqueadas, el Web Worker bloquea la penetración permitiendo deslizamiento lateral sobre la frontera y muestra el aviso diegético (*"Aún no tienes contactos en Portugalete"*, etc.). Puedes desbloquear cualquier municipio en tiempo real desde el panel inferior izquierdo del HUD.

### Modo Espectador (Inspección GIS Libre)
- Pulsa `TAB` o el botón **"🎥 Alternar Modo Espectador (TAB)"** en el HUD.
- En Modo Espectador las barreras de progresión se desactivan para el vuelo de cámara y puedes usar:
  - **Botones de Vista Aérea Rápida**: Vuelo directo (`flyTo`) a **1. Bilbao**, **2. Portugalete**, **3. Getxo**, **4. Santurtzi**, **5. Basauri** o **🌍 Vista General**.
  - `W` `A` `S` `D`: Vuelo horizontal libre.
  - `Espacio` / `Ctrl`: Subir / Bajar altitud.
  - `Shift`: Velocidad turbo de inspección.
  - **Ratón libre**: Rotación, inclinación y zoom nativos de CesiumJS.

---

## 5. Análisis de Riesgos Técnicos y Fallbacks Implementados

### 5.1. Cobertura de Cesium OSM Buildings en los 5 Municipios
- **Bilbao (Hub Central)**: Excelente cobertura de alturas (`height` y `building:levels`) en Abando, Indautxu, Casco Viejo, Abandoibarra (Torre Iberdrola, Museo Guggenheim, San Mamés). En la punta de Zorrotza algunas naves portuarias carecen de etiqueta de niveles.
- **Portugalete**: Muy buena definición volumétrica en el Casco Histórico y Repelega. Sin embargo, estructuras singulares de ingeniería como el **Puente de Bizkaia (Puente Colgante)** no siempre se representan con gálibo completo en OSM Buildings estándar.
- **Getxo**: Cobertura alta en Las Arenas y Algorta centro, pero los chalets unifamiliares de Neguri/Andra Mari y la **Terminal de Cruceros de Arriluze** suelen tener únicamente la huella 2D en OpenStreetMap, extruyéndose a la altura mínima por defecto (~3-4 m).
- **Santurtzi**: Alta fidelidad en Mamariga y Kabiezes, pero las explanadas logísticas, silos y terminales de contenedores del **Superpuerto del Abra Exterior** tienen baja cobertura de altura en OSM.
- **Basauri**: Es la zona con mayor riesgo geométrico en OSM: grandes polígonos industriales en la confluencia del Nervión e Ibaizabal (**Sidenor, Artunduaga, Mercabilbao**) tienen huellas 2D precisas pero con frecuencia carecen del atributo `building:levels`.
- **Fallback Implementado en el Prototipo**:
  1. **Geometría de Fallback Fusionada (`Primitive` Batching)**: `ZoneManager` incluye el sistema `buildBatchedFallbackBuildingsPrimitive()` que genera volúmenes 3D extruidos sobre coordenadas reales para naves industriales de Basauri, terminales del Superpuerto de Santurtzi, Arriluze en Getxo y el pórtico de Portugalete, fusionados en **1 sola draw call** (activable/desactivable desde el botón `🏗️ Fallback OSM: ON/OFF`).
  2. **Pipeline Offline para Producción**: Para la fase final, se recomienda extraer las huellas de OpenStreetMap de Bizkaia con Overpass API + cruzarlas con el **LiDAR / Catastro de la Diputación Foral de Bizkaia (GeoEuskadi)** para asignar la cota real de coronación a cada polígono industrial antes de convertirlo a 3D Tiles.

### 5.2. Rendimiento en GPUs de Gama Baja / Integradas
- **Riesgo**: Las GPUs integradas (Intel UHD/Iris, AMD Vega integrada) comparten memoria RAM del sistema como VRAM y sufren caídas severas de FPS si el `maximumScreenSpaceError` es inferior a 12 o si se acumulan múltiples tilesets residentes.
- **Mitigación**:
  - `HardwareProfiler.ts` inspecciona `WEBGL_debug_renderer_info` al arrancar y limita automáticamente `cacheBytes` a **1024 MB** en GPUs integradas (y **2048 MB** en GPUs dedicadas), con un `maximumScreenSpaceError` inicial adaptativo (16-20) regulable en vivo desde el HUD.
  - Uso estricto de `Cesium.Primitive` con fusión de `GeometryInstance` para perímetros y volúmenes auxiliares (1 sola draw call), reservando `Cesium.Entity` exclusivamente para el avatar dinámico del jugador.

### 5.3. Limitaciones del Plan Gratuito de Cesium ion al Escalar
- **Riesgo**: Con 15 GB/mes de transferencia en el plan Community, una sesión intensiva de desarrollo o pruebas públicas con decenas de jugadores recargando tiles sin caché agotaría la cuota mensual.
- **Mitigación**:
  - Precarga predictiva con `maximumScreenSpaceError` elevado (`SSE * 3`) y `cullRequestsWhileMovingMultiplier` agresivo para no descargar hojas de máxima resolución mientras la cámara se desplaza a gran velocidad.
  - Si el juego pasa a distribución pública comercial o supera los 15 GB/mes, el catálogo de edificios de Bizkaia (extraído de OSM + Catastro de Bizkaia bajo licencia abierta ODbL / CC-BY 4.0) puede empaquetarse con `3d-tiles-tools` / `py3dtilers` y servirse desde un CDN estático propio (Cloudflare R2 / GitHub Pages / S3) eliminando cualquier cuota por streaming.

---

## 6. Roadmap de la Siguiente Fase (Fase 2)

1. **Sistema de Misiones y Narrativa (`MissionManager`)**:
   - Conectar el grafo de misiones con el hook `zoneManager.setZoneUnlocked(zoneId, true)` cuando se completen los hitos (`mision_01` -> desbloqueo de Portugalete; `mision_02` -> Getxo; `mision_03` -> Santurtzi; `mision_04` -> Basauri).
2. **Tráfico Vehicular sobre Grafo Vial OSM (`TrafficSystem`)**:
   - Exportar las vías principales de Bizkaia (A-8, BI-637 Avanzada, N-634, Gran Vía) como grafo dirigido compacto en JSON.
   - Simular posiciones de vehículos en un segundo Web Worker y renderizarlos mediante `Cesium.ModelInstanceCollection` (instanciación por hardware en GPU, 1 draw call por tipo de vehículo).
3. **NPCs Peatones y Puntos de Contacto (`CrowdSystem`)**:
   - Spawners por densidad de barrio (Casco Viejo, Abando, Puerto Viejo de Algorta) usando `PointPrimitiveCollection` / instancias glTF de bajo poligonaje con LOD por distancia.
4. **Física Vehicular Ligera y Audio Ambiental**:
   - Integrar colisión raycast con las normales de `Cesium World Terrain` y zonas de audio ambiental (oleaje en el Abra/Getxo, ambiente portuario en Santurtzi, tráfico urbano en Moyúa).
