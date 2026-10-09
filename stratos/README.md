# STRATOS · F-22A Raptor

Demo técnica jugable de un simulador de caza moderno ficticio, centrada en el avión: modelo de vuelo físico, sistemas, cabina interactiva, efectos y sonido. Funciona en el navegador con Three.js y WebGL2, sin assets externos: geometría, texturas, sonido y terreno se generan por código al arrancar.

> Se pidió Unreal Engine 5 como primera opción. En este entorno (contenedor Linux sin GPU, sin editor ni toolchain de UE) no es posible compilar ni probar un proyecto UE5, así que la demo usa TypeScript, Three.js r186 y WebGL2. La arquitectura (sistemas separados, paso fijo de física, bus de eventos, entrada con perfiles HOTAS) se traslada a un motor nativo sin rediseño.

## Ejecutar

```bash
cd stratos
npm install
npm run dev            # http://localhost:5173  (calidad: ?q=LOW|MEDIUM|HIGH|ULTRA)
npm run build          # producción en dist/
npm run artifact       # build + página embebible en dist-artifact/
npm run test:physics   # 22 comprobaciones numéricas del modelo de vuelo (Node, sin navegador)
npm run typecheck
```

Necesita un navegador con WebGL2 y `EXT_clip_control`. Sin esa extensión cae a profundidad estándar. Objetivo: 60 FPS a 1440p en HIGH con una GPU de gama media-alta.

## Controles

| Tecla | Acción |
|---|---|
| W / S | Cabeceo (S = tirar) |
| A / D | Alabeo |
| Q / E | Guiñada / rueda de morro |
| Shift / Ctrl | Gases; mantener Shift al 100 % pasa el retén de postcombustión |
| Tab | Postcombustión |
| G · F · B | Tren · flaps (UP/TO/LDG) · aerofreno |
| Espacio · Z | Frenos de rueda · freno de estacionamiento |
| O | Secuencia de arranque automática (mueve los interruptores reales) |
| K · L · N · J | Cabina · luz de aterrizaje · luces de navegación · iluminación de cabina |
| X | FCS ASSIST / DIRECT · `,` `.` compensador en DIRECT |
| C, 1–6 | Cámaras: cabina, persecución, persecución cercana, cinemática, ala, cola |
| Ratón | Mirar (clic para capturar) · rueda = zoom · clic izquierdo pulsa el control bajo la retícula |
| `[` `]` · M · U | Páginas de MFD · mapa · modo HUD |
| T / Y | Hora / meteorología |
| P | Modo foto (WASD/QE, F = profundidad de campo) |
| F3 · F4 | Telemetría de ingeniería · vectores de fuerza |
| H · Esc · Retroceso | Ayuda · pausa · reaparecer |

Mando estándar y joystick/HOTAS genérico (perfil de ejes configurable en `InputSystem`).

## Qué hay dentro

**Física** (`src/aircraft/`), integrada a 240 Hz con interpolación de render:
- Cuerpo rígido 6-DOF con tensor de inercia, CG variable con el combustible y atmósfera ISA.
- Aerodinámica por coeficientes CL(α, M) con pérdida y recuperación, CD0(M), resistencia inducida K(M), efecto suelo, deriva y amortiguamientos.
- Superficies de control con actuadores limitados en velocidad, y autoridad dependiente de la presión dinámica e hidráulica.
- Fly-by-wire NDI (inversión dinámica):
  - Demanda de Nz y de velocidad de cabeceo.
  - Limitadores de AoA y de G.
  - Mantenimiento de senda con los mandos sueltos.
  - Protección contra toque de cola y amortiguador de derrotación.
  - Modo DIRECT con compensador.
- Motor turbofán:
  - Estados OFF → CRANK → LIGHTOFF → RUN, y también FLAMEOUT y FAILED.
  - Dinámica de N2, EGT y tobera variable.
  - Postcombustión por etapas.
  - Empuje con caída por densidad y ram.
- Combustible en 4 depósitos con fugas, más barras eléctricas (batería, generador, esencial).
- Tren de aterrizaje:
  - Amortiguador oleoneumático con muelle progresivo y válvula dosificadora.
  - Neumáticos con fricción y ángulo de deriva.
  - Dirección de rueda de morro y frenos en el tren principal.
  - Daño estructural por carga.
- Daño modular: sobre-G, sobrevelocidad, sobretemperatura, incendio, impactos por zona y efectos en cascada.

**Visual del avión** (`src/aircraft/visual/`):
- Fuselaje loft con chine, tomas de aire tipo caret y perfiles NACA reales en alas, estabilizadores y derivas.
- Superficies articuladas, tobera de pétalos y cúpula dorada con lluvia y escarcha.
- Pintura procedural con paneles, remaches enrasados, suciedad en el sentido del flujo, marcas e insignias, normal/ORM y clearcoat semimate.

**Cabina** (`src/cockpit/`):
- HUD colimado conforme: la simbología se dibuja en espacio angular y el combinador la reproyecta según la dirección de la mirada.
- 2 MFD con páginas ENGINE, FLIGHT, MAP, SYSTEMS, DAMAGE y FUEL.
- Instrumentos de reserva y paneles de avisos.
- Decenas de interruptores, guardas, pulsadores y mandos rotativos con animación, sonido y efecto real en los sistemas.
- Piloto con IK de dos huesos.

**Render** (`src/render/`):
- HDR con MSAA y profundidad invertida (reversed-Z).
- Sombras en cascada y SSAO a media resolución.
- Cielo físico con LUT, perspectiva aérea y nubes volumétricas temporales.
- Partículas suaves, distorsión térmica, bloom, DoF y desenfoque de movimiento.
- ACES y efectos de G (visión gris / túnel / red-out).

**Efectos** (`src/effects/`): llama de postcombustión con diamantes de choque, calima térmica, condensación sobre el ala y LERX, cono de vapor transónico, vórtices de punta de ala, estelas, humo de neumáticos, chispas, incendio y explosión.

**Sonido** (`src/audio/`): síntesis WebAudio por capas:
- Motor (zumbido de compresor, rugido, postcombustión) con Doppler y directividad trasera.
- Viento y ruido de capa límite.
- Mezcla interior/exterior según la cúpula.
- Clics por tipo de interruptor, golpes del tren y ruedas.
- Avisos con tono y voz.

## Texturas reales (CC0)

Además de la pintura procedural, el avión y la cabina usan 23 texturas escaneadas reales con licencia **CC0** (dominio público) de ambientCG y Poly Haven, descargadas de mirrors públicos en GitHub y reducidas a 512–1024 px (3,25 MB). Están en `public/textures/` y su procedencia está en `public/textures/CREDITS.md`.

- **Fuselaje:** se hornean en la pintura suciedad, manchas de agua, polvo, rayaduras y desgaste en bordes de ataque, tomas de aire y pasarelas, a su escala física.
- **Microdetalle triplanar** (`src/render/SurfaceDetail.ts`): grano de pintura, recubrimiento RAM, goma de neumáticos, aluminio cepillado, cromo de los amortiguadores y acero envejecido por calor en la tobera.
- **Cabina:**
  - Pintura gris desgastada y suelo antideslizante.
  - Anti-reflejos mate con borde de cuero.
  - Asiento con cojines de lona y arneses de cincha.
  - Empuñaduras de goma.
  - Polvo, huellas y rayaduras en la cúpula que solo se ven contra el sol.
- **Piloto:** mono Nomex de sarga, traje anti-G de lona, guantes y botas de cuero y máscara de goma.

`npm run textures` regenera el manifiesto (`src/assets/textureManifest.ts`). Si una imagen no carga, cada material vuelve a su versión procedural.

## Estructura

```
src/core      bucle, eventos, ajustes, matemáticas, atmósfera ISA
src/aircraft  física y sistemas; visual/ = geometría, texturas y modelo
src/cockpit   cabina, HUD, MFD, controles interactivos, piloto
src/camera    cámaras con física de cabeza y modos externos
src/effects   partículas, estelas y efectos del avión
src/audio     motor de sonido procedural
src/render    pipeline, materiales, shaders de post y AO
src/world     fondo: terreno CDLOD en workers, aeropuerto, agua, vegetación
src/atmosphere cielo, nubes, hora del día, meteorología
src/ui        menús, ayuda, telemetría y vectores de fuerza
tests         física en Node + capturas con Chromium headless (tests/shots/*.js)
```

## Pruebas

`npm run test:physics` vuela escenarios con guion y comprueba los números contra lo esperable en un caza moderno:
- Reposo en tierra y arranque del motor.
- Despegue a ~158 kt en MIL.
- Estabilidad con los mandos sueltos.
- Spawn en vuelo compensado.
- Velocidades máximas a nivel del mar y a 11 km.
- Límite de 9 G y limitador de AoA.
- Régimen de alabeo.
- Pérdida y recuperación en DIRECT.
- Aterrizaje completo, aterrizaje duro que daña el tren sin destruir el avión, y planeo tras apagado por falta de combustible.

`node tests/shot.mjs 0 tests/shots/exterior.js` (y el resto de guiones) captura vistas en Chromium headless a `tests/output/`.

## Cabina F-16 (FlightGear, GPL)

La cabina 3D es la del F-16 de FlightGear (Block 50), convertida a
`public/models/f16-cockpit.glb` con `scripts/f16/convert.py` (lee el árbol
XML + AC3D, evalúa las animaciones `select` para una configuración fija y
exporta las animaciones de agujas, interruptores, palanca, gases y pedales).
`src/cockpit/F16Cockpit.ts` reproduce esas animaciones con la simulación;
los controles interactivos, el HUD y los MFD se colocan sobre las piezas
reales. Por incluir ese modelo, el proyecto se distribuye bajo **GPL-2.0 o
posterior** (`LICENSE`); créditos en `public/models/F16-COCKPIT-CREDITS.md`.

Regenerar: `python3 scripts/f16/fetch.py` (descarga el modelo) y
`python3 scripts/f16/convert.py <dir> Models/Cockpit/Main/cockpit.xml <out> "Pilot_ext,Pilot_int" "" scripts/f16/dyn.json`.

## F-22A Raptor (modelo del usuario)

El avión del jugador es el F-22 modelado en Blender por el autor del proyecto
(`F22_Raptor_Perfil.blend`, librea a partir de imágenes de referencia propias).
`scripts/f22/export_glb.py` (con `pip install bpy`) lo convierte a
`public/models/f22.glb`: quita cámaras, luces y la cabina simplificada, abre el
hueco de la cabina bajo la cúpula, monta las piezas móviles bajo nodos con su
pivote (estabilizadores, flaps de las toberas 2D, cúpula, tren con
amortiguador, dirección y ruedas, compuertas) y hornea la librea procedural a
un atlas de 4096 px. `src/aircraft/visual/F22Model.ts` lo anima con la
simulación; la cabina F-16 se coloca en el punto de vista del F-22.

La física usa cifras públicas aproximadas del F-22 (19,7 t en vacío, 2 × F119,
78 m² de ala, 8,2 t de combustible): supercrucero a Mach 1,25 a 11 km sin
postcombustión. Si el modelo no carga, el juego vuelve al XF-41 procedural.

Regenerar: `python scripts/f22/export_glb.py F22_Raptor_Perfil.blend <salida> 4096`.
