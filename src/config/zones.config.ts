import { ZonesMap } from '../types/zones';

/**
 * Coordenadas iniciales del jugador (Plaza Federico Moyúa, Abando, Bilbao).
 */
export const INITIAL_PLAYER_SPAWN = {
  lon: -2.9349,
  lat: 43.2630,
  height: 22.0,
  headingDeg: 45.0,
};

/**
 * Configuración geográfica real (WGS84) de los 5 municipios del Gran Bilbao (Bizkaia, Euskadi).
 * Estructura estrictamente compatible con:
 * {
 *   bilbao: { desbloqueada: true, boundingBox, requisito: null },
 *   portugalete: { desbloqueada: false, boundingBox, requisito: 'mision_01' },
 *   ...
 * }
 */
export const INITIAL_ZONES_CONFIG: ZonesMap = {
  bilbao: {
    id: 'bilbao',
    nombre: 'Bilbao',
    descripcion: 'Hub urbano principal: Abando, Indautxu, Casco Viejo, Abandoibarra y Ría del Nervión.',
    desbloqueada: true,
    boundingBox: {
      west: -2.9780,
      south: 43.2380,
      east: -2.8980,
      north: 43.2850,
    },
    requisito: null,
    mensajeBloqueo: '',
    puntoInspeccion: {
      lon: -2.9340,
      lat: 43.2665,
      height: 520,
      headingDeg: 18,
      pitchDeg: -35,
    },
    colorHex: '#00e676',
    adyacentes: ['basauri', 'portugalete', 'getxo'],
    coberturaOsmNota:
      'Alta cobertura en Abando, Ensanche y Casco Viejo (Torre Iberdrola, Guggenheim, San Mamés). Algunas naves portuarias en Zorrotza usan altura por defecto.',
    fallbackFootprints: [
      {
        id: 'bilbao_zorrotza_puerto_01',
        label: 'Almacén Portuario Zorrotza (Fallback OSM)',
        lon: -2.9705,
        lat: 43.2775,
        widthMeters: 110,
        depthMeters: 45,
        heightMeters: 16,
        headingDeg: 32,
      },
    ],
  },

  portugalete: {
    id: 'portugalete',
    nombre: 'Portugalete',
    descripcion: 'Nudo de conexión en la Margen Izquierda, Puente Bizkaia (Puente Colgante) y Casco Histórico.',
    desbloqueada: false,
    boundingBox: {
      west: -3.0350,
      south: 43.3080,
      east: -3.0080,
      north: 43.3265,
    },
    requisito: 'mision_01',
    mensajeBloqueo: 'Aún no tienes contactos en Portugalete',
    puntoInspeccion: {
      lon: -3.0185,
      lat: 43.3185,
      height: 410,
      headingDeg: 315,
      pitchDeg: -32,
    },
    colorHex: '#ffab00',
    adyacentes: ['bilbao', 'getxo', 'santurtzi'],
    coberturaOsmNota:
      'Buena densidad residencial en Repelega y Casco Histórico. El Puente Colgante (Puente de Bizkaia) en OSM a veces carece de gálibo completo; se incluye pórtico estructural de referencia en fallback.',
    fallbackFootprints: [
      {
        id: 'portugalete_puente_bizkaia_torre_izq',
        label: 'Torre Pórtico Puente Bizkaia - Portugalete (Fallback OSM)',
        lon: -3.0178,
        lat: 43.3227,
        widthMeters: 18,
        depthMeters: 18,
        heightMeters: 61,
        headingDeg: 25,
      },
      {
        id: 'portugalete_muelle_churruca',
        label: 'Estación Transbordador Portugalete (Fallback OSM)',
        lon: -3.0185,
        lat: 43.3222,
        widthMeters: 38,
        depthMeters: 22,
        heightMeters: 14,
        headingDeg: 25,
      },
    ],
  },

  getxo: {
    id: 'getxo',
    nombre: 'Getxo',
    descripcion: 'Zona residencial y costera en la Margen Derecha: Las Arenas, Algorta, Puerto Viejo y Acantilados de La Galea.',
    desbloqueada: false,
    boundingBox: {
      west: -3.0380,
      south: 43.3266,
      east: -2.9850,
      north: 43.3820,
    },
    requisito: 'mision_02',
    mensajeBloqueo: 'Aún no tienes contactos en Getxo (Requiere cruzar desde Portugalete)',
    puntoInspeccion: {
      lon: -3.0115,
      lat: 43.3475,
      height: 550,
      headingDeg: 345,
      pitchDeg: -34,
    },
    colorHex: '#00e5ff',
    adyacentes: ['portugalete', 'bilbao'],
    coberturaOsmNota:
      'Cobertura media: Las Arenas y centro de Algorta tienen alturas detalladas, pero chalets de Neguri/Andra Mari y el Terminal de Cruceros de Arriluze suelen tener solo huella 2D (3 m por defecto en OSM).',
    fallbackFootprints: [
      {
        id: 'getxo_arriluze_cruceros',
        label: 'Terminal de Cruceros de Getxo - Arriluze (Fallback OSM)',
        lon: -3.0195,
        lat: 43.3402,
        widthMeters: 135,
        depthMeters: 42,
        heightMeters: 18,
        headingDeg: -15,
      },
      {
        id: 'getxo_faro_galea',
        label: 'Complejo Faro de La Galea (Fallback OSM)',
        lon: -3.0298,
        lat: 43.3722,
        widthMeters: 24,
        depthMeters: 24,
        heightMeters: 28,
        headingDeg: 0,
      },
    ],
  },

  santurtzi: {
    id: 'santurtzi',
    nombre: 'Santurtzi',
    descripcion: 'Zona portuaria e industrial: Superpuerto del Abra Exterior, Mamariga y puerto pesquero.',
    desbloqueada: false,
    boundingBox: {
      west: -3.0680,
      south: 43.3200,
      east: -3.0351,
      north: 43.3620,
    },
    requisito: 'mision_03',
    mensajeBloqueo: 'Aún no tienes contactos en el Puerto de Santurtzi',
    puntoInspeccion: {
      lon: -3.0460,
      lat: 43.3390,
      height: 540,
      headingDeg: 325,
      pitchDeg: -35,
    },
    colorHex: '#ff5252',
    adyacentes: ['portugalete'],
    coberturaOsmNota:
      'Los bloques residenciales de Mamariga y Kabiezes están bien definidos, pero las terminales de contenedores y silos del Superpuerto carecen de altura real en OSM.',
    fallbackFootprints: [
      {
        id: 'santurtzi_superpuerto_terminal_a',
        label: 'Terminal Logística Superpuerto A (Fallback OSM)',
        lon: -3.0510,
        lat: 43.3475,
        widthMeters: 190,
        depthMeters: 68,
        heightMeters: 24,
        headingDeg: -30,
      },
      {
        id: 'santurtzi_superpuerto_silos',
        label: 'Silos Portuarios Espigón Central (Fallback OSM)',
        lon: -3.0455,
        lat: 43.3435,
        widthMeters: 95,
        depthMeters: 50,
        heightMeters: 34,
        headingDeg: -30,
      },
    ],
  },

  basauri: {
    id: 'basauri',
    nombre: 'Basauri',
    descripcion: 'Periferia industrial y nudo ferroviario en la confluencia de los ríos Nervión e Ibaizabal.',
    desbloqueada: false,
    boundingBox: {
      west: -2.9050,
      south: 43.2180,
      east: -2.8680,
      north: 43.2480,
    },
    requisito: 'mision_04',
    mensajeBloqueo: 'Aún no tienes contactos en los polígonos de Basauri',
    puntoInspeccion: {
      lon: -2.8865,
      lat: 43.2355,
      height: 480,
      headingDeg: 140,
      pitchDeg: -34,
    },
    colorHex: '#e040fb',
    adyacentes: ['bilbao'],
    coberturaOsmNota:
      'Riesgo conocido: los grandes polígonos industriales (Artunduaga, Sidenor, Mercabilbao) tienen huellas 2D en OSM pero muchas naves carecen del tag building:levels, renderizándose demasiado bajas sin fallback.',
    fallbackFootprints: [
      {
        id: 'basauri_sidenor_nave_principal',
        label: 'Acería Industrial Valle del Nervión (Fallback OSM)',
        lon: -2.8815,
        lat: 43.2382,
        widthMeters: 220,
        depthMeters: 80,
        heightMeters: 26,
        headingDeg: 65,
      },
      {
        id: 'basauri_mercabilbao_nave',
        label: 'Complejo Logístico Mercabilbao (Fallback OSM)',
        lon: -2.8935,
        lat: 43.2305,
        widthMeters: 175,
        depthMeters: 62,
        heightMeters: 18,
        headingDeg: 40,
      },
    ],
  },
};
