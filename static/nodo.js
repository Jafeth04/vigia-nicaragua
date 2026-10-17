// VIGÍA · Nodo sensor
// Convierte un celular en desuso en un sensor fijo. Lee el acelerómetro
// (con gravedad) y según el modo detecta:
//   estructura: ondas P y S de un sismo, sacudida máxima e inclinación permanente
//   ladera:     inclinación lenta acumulada, su velocidad y vibración continua (lahar)
//   rio:        nivel del agua con un brazo y flotador (el ángulo del brazo = nivel)

const $ = (id) => document.getElementById(id);

const UMBRALES = {
  inclinacion: { amarillo: 1, rojo: 3, sostener_s: 5 }, // grados
  sacudida: { amarillo: 0.5, rojo: 2 }, // m/s²
  ladera: { incAmarillo: 0.5, incRojo: 2, velAmarillo: 0.2, velRojo: 1, vibracion: 0.15, vibracion_s: 10 },
  // STA/LTA: promedio corto (0,5 s) contra promedio largo (10 s)
  staLta: { sta: 0.5, lta: 10, disparo: 4, minimo: 0.08, calentamiento_s: 10 },
};
const KM_POR_SEG_SP = (6.0 * 3.5) / (6.0 - 3.5); // ~8,4 km por segundo entre onda P y S
const RANGO = { verde: 0, amarillo: 1, rojo: 2 };

const CLAVE = 'vigia-nodo';
let cfg = {
  id: 'nodo-' + VIGIA.uid().slice(0, 8),
  nombre: '', modo: 'ladera', comunidad: 'prueba', rol: 'A', tipo_lugar: 'ladera', personas: 0,
  lugar: 'managua', lat: null, lng: null,
  brazo_cm: 20, umbral_am_cm: 5, umbral_rojo_cm: 10, invertir: false,
  ...VIGIA.leer(CLAVE, {}),
};

let catalogo = null;
let conexion = null;
let calibrando = null; // { suma, n } mientras calibra
let monitoreando = false;
let g0 = null; // gravedad de referencia (calibración)
let g = null; // gravedad actual (filtrada)
let tPrevio = 0;
let tInicio = 0;
let muestras = 0;
let hz = 0;
const sl = { staV: 0, ltaV: 0, staH: 0, ltaH: 0, staM: 0, ltaM: 0 };
let evento = null; // sismo en curso
let pgaMax = 0; // pico de sacudida desde el último restablecimiento
let alarma = { nivel: 'verde', motivo: 'Todo normal' };
const sostenido = { amarillo: 0, rojo: 0 }; // segundos seguidos sobre el umbral de inclinación
let segundosVibrando = 0;
let historial = []; // [t, inclinación o nivel] de los últimos 2 minutos
let lectura = {};
let bateria = null;
let ultimoEnvio = 0;
let nivelEnviado = '';
let bloqueoPantalla = null;

// ---------- Vectores ----------
const sumar = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const restar = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const escalar = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const punto = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norma = (a) => Math.sqrt(punto(a, a));
const unitario = (a) => escalar(a, 1 / (norma(a) || 1));
const anguloGrados = (a, b) => (Math.acos(Math.min(1, Math.max(-1, punto(unitario(a), unitario(b))))) * 180) / Math.PI;

// ---------- Lectura del sensor ----------
function alMoverse(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x === null) return;
  const t = performance.now() / 1000;
  const dt = tPrevio ? Math.min(Math.max(t - tPrevio, 0.001), 0.2) : 0.016;
  tPrevio = t;
  muestras++;
  const ac = [a.x, a.y, a.z];

  if (calibrando) {
    calibrando.suma = sumar(calibrando.suma, ac);
    calibrando.n++;
    return;
  }
  if (!monitoreando) return;

  // Gravedad = promedio lento (≈1 s). Lo que sobra es movimiento.
  // Mientras el celular vibra (temblor, golpe, lodo), la sacudida "contamina" ese promedio
  // y parece inclinación. Entonces la gravedad casi se congela (≈30 s) hasta que pase.
  const agitado = evento || sl.staM > Math.max(0.15, 3 * sl.ltaM);
  g = sumar(g, escalar(restar(ac, g), Math.min(1, dt / (agitado ? 30 : 1.0))));
  const lineal = restar(ac, g);
  const vertical = unitario(g0); // el nodo está fijo: la vertical es la gravedad calibrada
  const v = punto(lineal, vertical);
  const componenteV = Math.abs(v);
  const componenteH = norma(restar(lineal, escalar(vertical, v)));
  const magnitud = norma(lineal);
  guardarTraza(v, punto(lineal, ejeHorizontal));

  actualizarStaLta(componenteV, componenteH, magnitud, dt);
  if (cfg.modo !== 'rio') detectarSismo(t, magnitud);
}

function actualizarStaLta(v, h, m, dt) {
  const k = (tau) => Math.min(1, dt / tau);
  sl.staV += (v - sl.staV) * k(UMBRALES.staLta.sta);
  sl.staH += (h - sl.staH) * k(0.3);
  sl.staM += (m - sl.staM) * k(UMBRALES.staLta.sta);
  if (!evento) { // durante un sismo el promedio largo se congela
    sl.ltaV += (v - sl.ltaV) * k(UMBRALES.staLta.lta);
    sl.ltaH += (h - sl.ltaH) * k(UMBRALES.staLta.lta);
    sl.ltaM += (m - sl.ltaM) * k(UMBRALES.staLta.lta);
  }
}

// Onda P: subida brusca del movimiento vertical (STA/LTA).
// Onda S: llega después, más fuerte y sobre todo horizontal.
// Segundos entre P y S × 8,4 = distancia aproximada al origen del sismo.
function detectarSismo(t, magnitud) {
  const U = UMBRALES.staLta;
  if (!evento) {
    const listo = t - tInicio > U.calentamiento_s;
    const razon = sl.staV / Math.max(sl.ltaV, 0.005);
    if (listo && razon > U.disparo && sl.staV > U.minimo) {
      evento = { tLocal: t, pga: magnitud, sDetectada: false, ultimoFuerte: t };
      conexion.enviar({ tipo: 'onda_p', id: cfg.id, t: VIGIA.ahora() });
      anotar('⚡ Posible onda P detectada');
    }
    return;
  }
  evento.pga = Math.max(evento.pga, magnitud);
  if (magnitud > Math.max(0.3, 4 * sl.ltaM)) evento.ultimoFuerte = t;

  if (!evento.sDetectada && t - evento.tLocal > 0.3 && sl.staH > Math.max(3 * sl.ltaH, 0.3) && sl.staH > sl.staV) {
    evento.sDetectada = true;
    const sp = t - evento.tLocal;
    const distancia = sp * KM_POR_SEG_SP;
    conexion.enviar({ tipo: 'onda_s', id: cfg.id, t: VIGIA.ahora(), sp, distancia_km: distancia });
    anotar(`🌊 Onda S ${sp.toFixed(1)} s después → origen a ~${distancia.toFixed(0)} km`);
  }

  if (t - evento.ultimoFuerte > 8) {
    pgaMax = Math.max(pgaMax, evento.pga);
    anotar(`Terminó el movimiento. Pico: ${evento.pga.toFixed(2)} m/s²`);
    conexion.enviar({ tipo: 'fin_sismo', id: cfg.id, pga: evento.pga });
    evento = null;
  }
}

// ---------- Evaluación (1 vez por segundo) ----------
function evaluar() {
  hz = muestras;
  muestras = 0;
  if (!monitoreando || !g) { pintar(); return; }
  const t = performance.now() / 1000;
  let nivel = 'verde';
  let motivo = 'Todo normal';
  const subir = (n, m) => { if (RANGO[n] > RANGO[nivel]) { nivel = n; motivo = m; } };

  if (cfg.modo === 'rio') {
    // El celular va pegado a lo largo del brazo: el eje Y sigue el ángulo del brazo.
    const seno = (v) => v[1] / (norma(v) || 1);
    const nivelCm = cfg.brazo_cm * (seno(g) - seno(g0)) * (cfg.invertir ? -1 : 1);
    guardarHistorial(t, nivelCm);
    const velocidad = velocidadPorMinuto(t, nivelCm);
    lectura = { nivel_cm: nivelCm, vel_nivel: velocidad };
    if (nivelCm >= cfg.umbral_rojo_cm) subir('rojo', `Crecida: nivel +${nivelCm.toFixed(0)} cm`);
    else if (nivelCm >= cfg.umbral_am_cm) subir('amarillo', `Nivel subiendo: +${nivelCm.toFixed(0)} cm`);
    alarma = { nivel, motivo }; // el nivel del río no queda "trabado": sigue al agua
  } else {
    const inclinacion = anguloGrados(g, g0);
    guardarHistorial(t, inclinacion);
    const pga = Math.max(pgaMax, evento ? evento.pga : 0);

    if (cfg.modo === 'estructura') {
      const U = UMBRALES.inclinacion;
      sostenido.rojo = inclinacion > U.rojo ? sostenido.rojo + 1 : 0;
      sostenido.amarillo = inclinacion > U.amarillo ? sostenido.amarillo + 1 : 0;
      lectura = { inclinacion, sacudida: sl.staM, pga, sta_lta: sl.staV / Math.max(sl.ltaV, 0.005), ruido: sl.ltaV, hz };
      if (sostenido.rojo >= U.sostener_s) subir('rojo', `Inclinación permanente ${inclinacion.toFixed(1)}°`);
      else if (sostenido.amarillo >= U.sostener_s) subir('amarillo', `Inclinación ${inclinacion.toFixed(1)}°`);
    } else { // ladera (A o B) y referencia (R): el celular nodo decide con los tres
      const U = UMBRALES.ladera;
      const velocidad = velocidadPorMinuto(t, inclinacion);
      segundosVibrando = sl.staM > U.vibracion ? segundosVibrando + 1 : 0;
      lectura = { inclinacion, vel_inclinacion: velocidad, vibracion: sl.staM, pga, ruido: sl.ltaV, hz };
      if (cfg.modo === 'referencia') {
        if (inclinacion > 1) subir('amarillo', `Referencia movida ${inclinacion.toFixed(1)}°: revisar anclaje`);
        if (segundosVibrando >= U.vibracion_s) subir('amarillo', 'Vibración en la referencia (posible sismo)');
      } else {
        if (segundosVibrando >= U.vibracion_s) subir('rojo', 'Vibración continua del terreno');
        if (inclinacion > U.incRojo || velocidad > U.velRojo) subir('rojo', `Movimiento: ${inclinacion.toFixed(1)}° (${velocidad.toFixed(1)}°/min)`);
        else if (inclinacion > U.incAmarillo || velocidad > U.velAmarillo) subir('amarillo', `Movimiento: ${inclinacion.toFixed(1)}° (${velocidad.toFixed(1)}°/min)`);
      }
    }
    if (pga > UMBRALES.sacudida.rojo) subir('rojo', `Sacudida fuerte (${pga.toFixed(1)} m/s²)`);
    else if (pga > UMBRALES.sacudida.amarillo) subir('amarillo', `Sacudida moderada (${pga.toFixed(1)} m/s²)`);

    // En estructura y ladera la alarma queda trabada hasta que alguien la restablezca.
    if (RANGO[nivel] > RANGO[alarma.nivel]) alarma = { nivel, motivo };
  }
  pintar();
  enviarEstado();
}

function guardarHistorial(t, valor) {
  historial.push([t, valor]);
  while (historial.length && t - historial[0][0] > 120) historial.shift();
}

function velocidadPorMinuto(t, valor) {
  const referencia = historial.find(([ti]) => t - ti <= 60);
  if (!referencia || t - referencia[0] < 10) return 0;
  return (valor - referencia[1]) / ((t - referencia[0]) / 60);
}

// ---------- Comunicación ----------
function enviarHola() {
  conexion.enviar({
    tipo: 'hola',
    nodo: {
      id: cfg.id, nombre: cfg.nombre || cfg.id, modo: cfg.modo, tipo_lugar: cfg.tipo_lugar,
      personas: Number(cfg.personas) || 0, lugar: cfg.lugar, lat: cfg.lat, lng: cfg.lng,
      comunidad: enComunidad() ? cfg.comunidad : null,
      rol: cfg.modo === 'referencia' ? 'R' : cfg.modo === 'ladera' ? cfg.rol : null,
    },
  }, { encolar: false });
  nivelEnviado = '';
}

function enviarEstado() {
  const ahora = Date.now();
  if (alarma.nivel === nivelEnviado && ahora - ultimoEnvio < 3000) return;
  const valores = {};
  for (const [k, v] of Object.entries(lectura)) valores[k] = Math.round(v * 100) / 100;
  conexion.enviar({
    tipo: 'estado', id: cfg.id, estado: alarma.nivel, motivo: alarma.motivo, valores,
    bateria: bateria ? Math.round(bateria.level * 100) : null,
    cargando: bateria ? bateria.charging : null,
  }, { encolar: alarma.nivel !== nivelEnviado }); // los cambios de estado se encolan; las lecturas repetidas no
  nivelEnviado = alarma.nivel;
  ultimoEnvio = ahora;
}

const enComunidad = () => (cfg.modo === 'ladera' || cfg.modo === 'referencia') && !!cfg.comunidad;
let estadoComunidad = null; // lo que decidió el celular nodo con A, B y R

function alMensaje(msg) {
  if (msg.tipo === 'restablecer') restablecer('desde el panel');
  if (msg.tipo === 'reiniciado') { restablecer('el sistema se reinició'); estadoComunidad = null; enviarHola(); }
  if (msg.tipo === 'estado_comunidad' && enComunidad()) {
    if (estadoComunidad && estadoComunidad.nivel !== msg.nivel) anotar(`Comunidad: ${NOMBRE_COMUNIDAD[msg.nivel]}. ${msg.motivo}`);
    estadoComunidad = msg;
    pintar();
  }
}

// ---------- Control ----------
async function pedirPermisoSensores() {
  // iPhone exige pedir permiso con un toque del usuario
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    const respuesta = await DeviceMotionEvent.requestPermission();
    if (respuesta !== 'granted') throw new Error('Permiso de sensores denegado');
  }
}

async function calibrarEIniciar() {
  leerFormulario();
  try {
    await pedirPermisoSensores();
  } catch (e) {
    alertaEnPagina('El iPhone negó el permiso de movimiento. Cierra Safari por completo (deslízalo hacia arriba), '
      + 'vuelve a abrir esta página y, al tocar "Calibrar e iniciar", elige "Permitir". Si no aparece la pregunta: '
      + 'Ajustes › Safari › Avanzado › Datos de sitios web › borra trycloudflare.com y repite.');
    return;
  }
  mostrarMonitor();
  if (!conexion) {
    conexion = VIGIA.conectar('nodo', {
      id: cfg.id,
      alMensaje,
      alCambiarConexion: (ok) => { if (ok) enviarHola(); pintar(); },
    });
  } else {
    enviarHola();
  }
  mantenerPantallaEncendida();
  await calibrar();
}

async function calibrar() {
  monitoreando = false;
  calibrando = { suma: [0, 0, 0], n: 0 };
  alarma = { nivel: 'verde', motivo: 'Calibrando… no muevas el celular' };
  pintar();
  await new Promise((ok) => setTimeout(ok, 5000));
  if (calibrando.n < 20) {
    calibrando = null;
    alarma = { nivel: 'verde', motivo: 'Sin datos del acelerómetro' };
    pintar();
    anotar('❌ No llegan datos del acelerómetro. ¿HTTPS? ¿El celular tiene sensor?');
    return;
  }
  g0 = escalar(calibrando.suma, 1 / calibrando.n);
  g = [...g0];
  // Eje horizontal fijo para dibujar el sismógrafo: el eje X del celular proyectado al plano horizontal.
  const u0 = unitario(g0);
  ejeHorizontal = unitario(restar([1, 0, 0], escalar(u0, punto([1, 0, 0], u0))));
  if (norma(ejeHorizontal) < 0.5) ejeHorizontal = unitario(restar([0, 1, 0], escalar(u0, punto([0, 1, 0], u0))));
  calibrando = null;
  Object.keys(sl).forEach((k) => { sl[k] = 0; });
  historial = [];
  evento = null;
  tInicio = performance.now() / 1000;
  restablecer('calibración nueva');
  monitoreando = true;
}

function restablecer(razon) {
  alarma = { nivel: 'verde', motivo: 'Todo normal' };
  pgaMax = 0;
  sostenido.amarillo = sostenido.rojo = 0;
  segundosVibrando = 0;
  anotar(`🟢 Alarma restablecida (${razon})`);
  pintar();
}

async function mantenerPantallaEncendida() {
  try {
    if ('wakeLock' in navigator) bloqueoPantalla = await navigator.wakeLock.request('screen');
  } catch (e) { /* no disponible en este navegador */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && monitoreando) mantenerPantallaEncendida();
});

// ---------- Sismógrafo en vivo ----------
const TRAZA = 600; // ~10 s a 60 lecturas/s
const trazaV = new Float32Array(TRAZA);
const trazaH = new Float32Array(TRAZA);
let trazaPos = 0;
let ejeHorizontal = [1, 0, 0];

function guardarTraza(v, h) {
  trazaV[trazaPos] = v;
  trazaH[trazaPos] = h;
  trazaPos = (trazaPos + 1) % TRAZA;
}

let ultimoDibujo = 0;
function dibujarSismografo(ahora) {
  requestAnimationFrame(dibujarSismografo);
  if ($('vista-monitor').hidden || ahora - ultimoDibujo < 33) return; // ~30 cuadros por segundo
  ultimoDibujo = ahora;
  const lienzo = $('sismografo');
  const ratio = window.devicePixelRatio || 1;
  const ancho = lienzo.clientWidth;
  const alto = lienzo.clientHeight;
  if (lienzo.width !== Math.round(ancho * ratio)) { lienzo.width = Math.round(ancho * ratio); lienzo.height = Math.round(alto * ratio); }
  const ctx = lienzo.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, ancho, alto);
  let maximo = 0.5;
  for (let i = 0; i < TRAZA; i++) maximo = Math.max(maximo, Math.abs(trazaV[i]), Math.abs(trazaH[i]));
  $('escala-sismografo').textContent = `±${maximo.toFixed(1).replace('.', ',')} m/s²`;
  ctx.strokeStyle = 'rgba(140, 153, 170, .25)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, alto / 2);
  ctx.lineTo(ancho, alto / 2);
  ctx.stroke();
  const trazar = (datos, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < TRAZA; i++) {
      const x = (i / (TRAZA - 1)) * ancho;
      const y = alto / 2 - (datos[(trazaPos + i) % TRAZA] / maximo) * (alto / 2 - 4);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  trazar(trazaH, 'rgba(245, 184, 61, .85)'); // horizontal (ámbar): la onda S se ve aquí
  trazar(trazaV, '#46b9f5'); // vertical (celeste): la onda P se ve aquí
}

// ---------- Interfaz ----------
const ETIQUETAS = {
  inclinacion: ['Inclinación', '°'],
  sacudida: ['Sacudida ahora', 'm/s²'],
  pga: ['Pico de sacudida', 'm/s²'],
  sta_lta: ['STA/LTA · dispara >4', ''],
  vel_inclinacion: ['Velocidad', '°/min'],
  vibracion: ['Vibración del suelo', 'm/s²'],
  nivel_cm: ['Nivel del agua', 'cm'],
  vel_nivel: ['Subida', 'cm/min'],
  ruido: ['Ruido de fondo', 'm/s²'],
  hz: ['Lecturas por segundo', ''],
};
const NOMBRE_MODO = {
  ladera: '⛰️ Sensor de ladera', referencia: '📍 Referencia R · suelo estable',
  estructura: '🏫 Estructura · sismo e inclinación', rio: '🌊 Río · nivel del agua',
};
const NOMBRE_NIVEL = { verde: 'NORMAL', amarillo: 'ATENCIÓN', rojo: 'ALERTA' };
const NOMBRE_COMUNIDAD = { normal: 'NORMAL', atencion: 'ATENCIÓN', alerta: 'ALERTA' };
const COLOR_COMUNIDAD = { normal: 'verde', atencion: 'amarillo', alerta: 'rojo' };

function nombreComunidad() {
  const c = catalogo && catalogo.comunidades.find((x) => x.id === cfg.comunidad);
  return c ? c.nombre : cfg.comunidad;
}

function pintar() {
  if ($('vista-monitor').hidden) return;
  $('txt-nombre').textContent = cfg.nombre || cfg.id;
  const rol = cfg.modo === 'ladera' ? ` ${cfg.rol}` : '';
  $('txt-modo').textContent = enComunidad() ? `${NOMBRE_MODO[cfg.modo]}${rol} · ${nombreComunidad()}` : NOMBRE_MODO[cfg.modo];
  const propio = $('txt-propio');
  if (enComunidad() && estadoComunidad && !calibrando) {
    // El semáforo grande muestra lo que decidió el celular nodo; abajo, lo que mide este sensor.
    $('semaforo').className = `estado-nodo ${COLOR_COMUNIDAD[estadoComunidad.nivel]}`;
    $('txt-quien').textContent = 'Comunidad';
    $('txt-estado').textContent = NOMBRE_COMUNIDAD[estadoComunidad.nivel];
    $('txt-motivo').textContent = estadoComunidad.motivo || 'Sin movimiento en la ladera';
    propio.hidden = false;
    propio.textContent = `Este sensor: ${alarma.nivel === 'verde' ? 'sin movimiento' : alarma.motivo}`;
  } else {
    $('semaforo').className = `estado-nodo ${calibrando ? 'calibrando' : alarma.nivel}`;
    $('txt-quien').textContent = enComunidad() ? 'Este sensor' : '';
    $('txt-estado').textContent = calibrando ? 'CALIBRANDO' : NOMBRE_NIVEL[alarma.nivel];
    $('txt-motivo').textContent = alarma.motivo;
    propio.hidden = true;
  }
  $('angulo-actual').textContent = g && g0 ? `${anguloGrados(g, g0).toFixed(2)}°` : '—';
  $('lecturas').innerHTML = Object.entries(lectura).map(([k, v]) => {
    const [nombre, unidad] = ETIQUETAS[k] || [k, ''];
    const decimales = k === 'hz' ? 0 : k === 'nivel_cm' ? 1 : 2;
    return `<div class="lectura"><dt>${nombre}</dt><dd>${v.toFixed(decimales)}<span>${unidad}</span></dd></div>`;
  }).join('');
  const conectado = conexion && conexion.conectado;
  $('ind-conexion').textContent = conectado ? 'En línea' : 'Sin conexión';
  $('ind-conexion').className = `conexion ${conectado ? 'ok' : 'mal'}`;
  $('ind-hz').textContent = `${hz} lecturas/s`;
  $('ind-bateria').textContent = bateria ? `Batería ${Math.round(bateria.level * 100)}%${bateria.charging ? ' · cargando' : ''}` : '';
  $('ind-cola').textContent = conexion && conexion.pendientes ? `${conexion.pendientes} mensajes en cola` : '';
  $('txt-rol').textContent = cfg.modo === 'ladera' ? cfg.rol : cfg.modo === 'referencia' ? 'R' : '';
  pintarChequeo(conectado);
  pintarNegro();
}

// Lista de chequeo para quien instala: todo en verde = el sensor quedó bien puesto.
function pintarChequeo(conectado) {
  const items = [];
  const agregar = (ok, texto, detalle = '') => items.push({ ok, texto, detalle });
  agregar(hz >= 20, hz >= 20 ? `El sensor mide (${hz} lecturas por segundo)` : 'No llegan lecturas del sensor',
    hz >= 20 ? '' : 'Revisa que la página esté en https:// y que diste permiso de movimiento.');
  agregar(!!conectado, conectado ? 'En línea con el servidor' : 'Sin conexión', conectado ? '' : 'Revisa el WiFi o los datos móviles.');
  agregar(!!g0 && !calibrando, g0 ? 'Calibrado en su posición' : 'Falta calibrar', g0 ? '' : 'Toca «Recalibrar» con el celular ya instalado y quieto.');
  if (enComunidad()) {
    agregar(!!estadoComunidad, estadoComunidad ? `El nodo recibe este sensor (${nombreComunidad()})` : 'El nodo aún no confirma este sensor',
      estadoComunidad ? '' : 'Espera unos segundos; si sigue igual, revisa que A, B y R eligieron la misma comunidad.');
  }
  if (cfg.modo !== 'rio' && g && g0) {
    const inc = anguloGrados(g, g0);
    agregar(inc < 0.3, inc < 0.3 ? `Firme (${inc.toFixed(2)}° desde la calibración)` : `Se movió ${inc.toFixed(1)}° desde la calibración`,
      inc < 0.3 ? '' : 'Si no fue la tierra, revisa que esté bien sujeto y recalibra.');
  }
  if (bateria) {
    const pct = Math.round(bateria.level * 100);
    const okBat = pct >= 20 || bateria.charging;
    agregar(okBat, `Batería ${pct} %${bateria.charging ? ' (cargando)' : ''}`, okBat ? '' : 'Conecta el cargador o revisa el panel solar.');
  } else {
    agregar(true, 'Batería: este celular no la informa a la página', 'Pasa en iPhone. Vigila la carga a mano.');
  }
  const pantalla = bloqueoPantalla && !bloqueoPantalla.released;
  agregar(!!pantalla, pantalla ? 'La pantalla no se apagará sola' : 'La pantalla podría apagarse',
    pantalla ? '' : 'Desactiva el bloqueo automático en los ajustes del celular.');
  $('chequeo').innerHTML = items.map((i) =>
    `<li class="${i.ok ? 'ok' : 'mal'}"><span>${i.texto}${i.detalle ? `<small>${i.detalle}</small>` : ''}</span></li>`).join('');
  const bien = items.filter((i) => i.ok).length;
  $('chequeo-resumen').textContent = `${bien}/${items.length} listo`;
}

function pintarNegro() {
  if ($('negro').hidden) return;
  const comunidad = enComunidad() && estadoComunidad;
  const color = comunidad ? COLOR_COMUNIDAD[estadoComunidad.nivel] : alarma.nivel;
  $('negro-punto').className = `negro-punto ${color}`;
  $('negro-texto').textContent = comunidad ? `${NOMBRE_COMUNIDAD[estadoComunidad.nivel]}` : NOMBRE_NIVEL[alarma.nivel];
}

function anotar(texto) {
  const li = document.createElement('li');
  const hora = document.createElement('time');
  hora.textContent = VIGIA.hora(Date.now());
  const span = document.createElement('span');
  span.textContent = texto;
  li.append(hora, span);
  $('registro').prepend(li);
  while ($('registro').children.length > 8) $('registro').lastChild.remove();
}

const modoElegido = () => (document.querySelector('input[name="modo"]:checked') || { value: 'ladera' }).value;

function alertaEnPagina(texto) {
  const aviso = $('aviso-seguro');
  aviso.hidden = false;
  aviso.textContent = '⚠️ ' + texto;
}

function mostrarMonitor() {
  $('vista-config').hidden = true;
  $('vista-monitor').hidden = false;
  pintar();
}

function mostrarConfig() {
  $('vista-monitor').hidden = true;
  $('vista-config').hidden = false;
}

function llenarFormulario() {
  $('cfg-nombre').value = cfg.nombre;
  document.querySelector(`input[name="modo"][value="${cfg.modo}"]`).checked = true;
  $('cfg-tipo').value = cfg.tipo_lugar;
  $('cfg-personas').value = cfg.personas;
  $('cfg-lugar').value = cfg.lugar;
  $('cfg-brazo').value = cfg.brazo_cm;
  $('cfg-umbral-am').value = cfg.umbral_am_cm;
  $('cfg-umbral-rojo').value = cfg.umbral_rojo_cm;
  $('cfg-invertir').checked = cfg.invertir;
  $('cfg-comunidad').value = cfg.comunidad;
  $('cfg-rol').value = cfg.rol;
  if (cfg.modo === 'estructura' || cfg.modo === 'rio') document.querySelector('details.ampliacion').open = true;
  mostrarCamposSegunModo(cfg.modo);
  $('txt-ubicacion').textContent = cfg.lat !== null ? `GPS: ${cfg.lat.toFixed(4)}, ${cfg.lng.toFixed(4)}` : '';
}

function leerFormulario() {
  cfg.nombre = $('cfg-nombre').value.trim();
  cfg.modo = modoElegido();
  cfg.tipo_lugar = $('cfg-tipo').value;
  cfg.personas = Number($('cfg-personas').value) || 0;
  if ($('cfg-lugar').value !== cfg.lugar) { cfg.lat = null; cfg.lng = null; } // cambió la zona a mano
  cfg.lugar = $('cfg-lugar').value;
  cfg.brazo_cm = Number($('cfg-brazo').value) || 20;
  cfg.umbral_am_cm = Number($('cfg-umbral-am').value) || 5;
  cfg.umbral_rojo_cm = Number($('cfg-umbral-rojo').value) || 10;
  cfg.invertir = $('cfg-invertir').checked;
  cfg.comunidad = $('cfg-comunidad').value;
  cfg.rol = $('cfg-rol').value;
  if (enComunidad()) cfg.tipo_lugar = 'ladera';
  estadoComunidad = null;
  VIGIA.guardar(CLAVE, cfg);
}

function mostrarCamposSegunModo(modo) {
  const comunidad = modo === 'ladera' || modo === 'referencia';
  $('cfg-rio').hidden = modo !== 'rio';
  $('cfg-comunidad-caja').hidden = !comunidad;
  $('cfg-rol-caja').hidden = modo !== 'ladera';
  $('cfg-sitio').hidden = comunidad; // en una comunidad, el lugar y las personas vienen de la comunidad
  $('cfg-lugar-caja').hidden = comunidad;
}

// ---------- Prueba de ángulos conocidos ----------
const CLAVE_ANGULOS = 'vigia-angulos';

function pintarAngulos() {
  const pruebas = VIGIA.leer(CLAVE_ANGULOS, []);
  $('tabla-angulos').innerHTML = pruebas.map((p) =>
    `<tr><td>${p.real.toFixed(1)}°</td><td>${p.medido.toFixed(2)}°</td><td>${p.error >= 0 ? '+' : ''}${p.error.toFixed(2)}°</td></tr>`).join('')
    || '<tr><td colspan="3">Aún no hay pruebas.</td></tr>';
}

function registrarAngulo() {
  const real = Number($('angulo-real').value);
  if (!g || !g0) { anotar('Primero calibra el sensor en posición plana'); return; }
  if (!Number.isFinite(real) || $('angulo-real').value === '') { anotar('Escribe el ángulo real de la cuña'); return; }
  const medido = anguloGrados(g, g0);
  const pruebas = VIGIA.leer(CLAVE_ANGULOS, []);
  pruebas.unshift({ real, medido, error: medido - real });
  VIGIA.guardar(CLAVE_ANGULOS, pruebas.slice(0, 12));
  conexion.enviar({ tipo: 'calibracion', id: cfg.id, real, medido });
  anotar(`📐 Ángulo real ${real.toFixed(1)}°, medido ${medido.toFixed(2)}°`);
  $('angulo-real').value = '';
  pintarAngulos();
}

async function iniciarPagina() {
  if (!window.isSecureContext) $('aviso-seguro').hidden = false;
  catalogo = await VIGIA.catalogo();
  $('cfg-lugar').innerHTML = catalogo.lugares.map((l) => `<option value="${l.id}">${VIGIA.esc(l.nombre)}</option>`).join('');
  $('cfg-comunidad').innerHTML = catalogo.comunidades.map((c) => `<option value="${c.id}">${VIGIA.esc(c.nombre)}</option>`).join('');
  llenarFormulario();
  pintarAngulos();

  document.querySelectorAll('input[name="modo"]').forEach((radio) => radio.addEventListener('change', () => {
    mostrarCamposSegunModo(modoElegido());
  }));
  $('btn-angulo').addEventListener('click', registrarAngulo);
  $('btn-negro').addEventListener('click', () => { $('negro').hidden = false; pintarNegro(); });
  $('negro').addEventListener('click', () => { $('negro').hidden = true; pintar(); });
  $('btn-gps').addEventListener('click', () => {
    if (!navigator.geolocation) { $('txt-ubicacion').textContent = 'Este navegador no tiene GPS'; return; }
    $('txt-ubicacion').textContent = 'Buscando…';
    navigator.geolocation.getCurrentPosition((pos) => {
      cfg.lat = pos.coords.latitude;
      cfg.lng = pos.coords.longitude;
      cfg.lugar = VIGIA.lugarMasCercano(catalogo.lugares, cfg.lat, cfg.lng).id;
      VIGIA.guardar(CLAVE, cfg);
      llenarFormulario();
    }, (err) => { $('txt-ubicacion').textContent = 'No se pudo: ' + err.message; }, { enableHighAccuracy: true, timeout: 15000 });
  });
  $('btn-iniciar').addEventListener('click', calibrarEIniciar);
  $('btn-recalibrar').addEventListener('click', calibrar);
  $('btn-restablecer').addEventListener('click', () => restablecer('manual'));
  $('btn-config').addEventListener('click', () => { monitoreando = false; mostrarConfig(); });

  window.addEventListener('devicemotion', alMoverse);
  if (navigator.getBattery) navigator.getBattery().then((b) => { bateria = b; }).catch(() => {});
  setInterval(evaluar, 1000);
  requestAnimationFrame(dibujarSismografo);
}

iniciarPagina();
