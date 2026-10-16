// VIGÍA · App Comunidad
// Reportes en 3 toques que funcionan sin internet (se guardan y se envían
// solos cuando vuelve la señal), respaldo por SMS y alertas de sismo con
// cuenta regresiva hasta que llegue la onda fuerte.

const $ = (id) => document.getElementById(id);
const CLAVE_CFG = 'vigia-comunidad';
const CLAVE_COLA = 'vigia-cola';
const CLAVE_HISTORIAL = 'vigia-mis-reportes';

let catalogo = null;
let cfg = { zona: 'managua', lat: null, lng: null, numeroSms: '', ...VIGIA.leer(CLAVE_CFG, {}) };
let tipoElegido = null;
let fotoActual = null;
let enviando = false;
let audio = null;
let alertaActual = null;
let temporizadorAlerta = null;
let conexion = null;

// ---------- Ubicación ----------
function miPosicion() {
  if (cfg.lat !== null) return { lat: cfg.lat, lng: cfg.lng };
  const lugar = catalogo.lugares.find((l) => l.id === cfg.zona) || catalogo.lugares[0];
  return { lat: lugar.lat, lng: lugar.lng };
}

function guardarCfg() { VIGIA.guardar(CLAVE_CFG, cfg); }

// ---------- Reportes ----------
function nuevoReporte() {
  const pos = miPosicion();
  return {
    id: VIGIA.uid(),
    tipo: tipoElegido,
    personas: Number($('personas').value) || 1,
    lugar: $('lugar').value,
    descripcion: $('descripcion').value.trim(),
    foto: fotoActual,
    lat: pos.lat,
    lng: pos.lng,
    zona: cfg.zona,
    creado: Date.now(),
    origen: 'app',
  };
}

function enviarReporte() {
  const reporte = nuevoReporte();
  const cola = VIGIA.leer(CLAVE_COLA, []);
  cola.push(reporte);
  VIGIA.guardar(CLAVE_COLA, cola);
  agregarAlHistorial(reporte, 'pendiente');
  volverAlInicio();
  vaciarCola();
}

async function vaciarCola() {
  if (enviando) return;
  enviando = true;
  try {
    let cola = VIGIA.leer(CLAVE_COLA, []);
    while (cola.length) {
      try {
        await VIGIA.postJSON('/api/reportes', cola[0]);
        marcarEnHistorial(cola[0].id, 'enviado');
      } catch (e) {
        if (!e.status || e.status >= 500) break; // sin conexión: se reintenta luego
        marcarEnHistorial(cola[0].id, 'rechazado');
      }
      cola.shift();
      VIGIA.guardar(CLAVE_COLA, cola);
    }
  } finally {
    enviando = false;
    pintarHistorial();
  }
}

function textoSms(reporte) {
  return `VIGIA ${reporte.tipo.toUpperCase()} ${reporte.personas} ${reporte.lat.toFixed(4)},${reporte.lng.toFixed(4)}`;
}

function agregarAlHistorial(reporte, estado) {
  const historial = VIGIA.leer(CLAVE_HISTORIAL, []);
  historial.unshift({ id: reporte.id, tipo: reporte.tipo, personas: reporte.personas, creado: reporte.creado, estado });
  VIGIA.guardar(CLAVE_HISTORIAL, historial.slice(0, 15));
  pintarHistorial();
}

function marcarEnHistorial(id, estado) {
  const historial = VIGIA.leer(CLAVE_HISTORIAL, []);
  const item = historial.find((h) => h.id === id);
  if (item) item.estado = estado;
  VIGIA.guardar(CLAVE_HISTORIAL, historial);
}

const TEXTO_ESTADO = { pendiente: '⏳ En cola', enviado: '✅ Recibido', sms: '✉️ Enviado por SMS', rechazado: '❌ Rechazado' };

function pintarHistorial() {
  const historial = VIGIA.leer(CLAVE_HISTORIAL, []);
  $('mis-reportes').innerHTML = historial.map((h) => {
    const tipo = catalogo.tipos_reporte[h.tipo];
    return `<li><span>${tipo.emoji} ${VIGIA.esc(tipo.nombre)} · ${h.personas} pers.</span>
      <small>${VIGIA.hora(h.creado)} · ${TEXTO_ESTADO[h.estado] || h.estado}</small></li>`;
  }).join('') || '<li><small>Aún no enviaste reportes.</small></li>';
  const pendientes = VIGIA.leer(CLAVE_COLA, []).length;
  $('estado-cola').textContent = pendientes
    ? `⏳ ${pendientes} reporte(s) esperando señal. Se enviarán solos.`
    : '';
}

// ---------- Foto ----------
function comprimirFoto(archivo) {
  return new Promise((listo) => {
    const lector = new FileReader();
    lector.onload = () => {
      const img = new Image();
      img.onload = () => {
        const escala = Math.min(1, 640 / Math.max(img.width, img.height));
        const lienzo = document.createElement('canvas');
        lienzo.width = Math.round(img.width * escala);
        lienzo.height = Math.round(img.height * escala);
        lienzo.getContext('2d').drawImage(img, 0, 0, lienzo.width, lienzo.height);
        listo(lienzo.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = () => listo(null);
      img.src = lector.result;
    };
    lector.onerror = () => listo(null);
    lector.readAsDataURL(archivo);
  });
}

// ---------- Pasos del formulario ----------
function elegirTipo(tipo) {
  tipoElegido = tipo;
  const t = catalogo.tipos_reporte[tipo];
  $('titulo-detalle').textContent = `${t.emoji} ${t.nombre}`;
  $('personas').value = 1;
  $('descripcion').value = '';
  fotoActual = null;
  $('vista-foto').hidden = true;
  $('paso-tipo').hidden = true;
  $('paso-detalle').hidden = false;
  actualizarEnlaceSms();
}

function volverAlInicio() {
  $('paso-detalle').hidden = true;
  $('paso-tipo').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function actualizarEnlaceSms() {
  if (!tipoElegido) return;
  const texto = textoSms(nuevoReporte());
  $('btn-sms').href = `sms:${encodeURIComponent(cfg.numeroSms)}?body=${encodeURIComponent(texto)}`;
}

// ---------- Alertas ----------
function activarSonido() {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    audio.resume();
    pitar(0.15);
    $('btn-alertas').textContent = '🔔 Alertas con sonido activadas';
    $('btn-alertas').disabled = true;
  } catch (e) {
    $('btn-alertas').textContent = 'Este navegador no permite sonido';
  }
}

function pitar(duracion = 0.35, frecuencia = 880) {
  if (!audio) return;
  const osc = audio.createOscillator();
  const vol = audio.createGain();
  osc.type = 'square';
  osc.frequency.value = frecuencia;
  vol.gain.value = 0.25;
  osc.connect(vol).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + duracion);
}

function alertaSismo(msg) {
  const nueva = !alertaActual || alertaActual.id !== msg.id;
  const pos = miPosicion();
  const distancia = VIGIA.distanciaKm(pos.lat, pos.lng, msg.lat, msg.lng);
  alertaActual = { ...msg, distancia, llegadaS: msg.t0 + (distancia / msg.vs) * 1000 };
  $('alerta-sismo').hidden = false;
  if (nueva) {
    if (navigator.vibrate) navigator.vibrate([600, 200, 600, 200, 600, 200, 600]);
    clearInterval(temporizadorAlerta);
    temporizadorAlerta = setInterval(tickAlerta, 100);
  }
  tickAlerta();
}

let ultimoPitido = 0;
function tickAlerta() {
  if (!alertaActual) return;
  const restante = (alertaActual.llegadaS - VIGIA.ahora()) / 1000;
  const lejos = alertaActual.distancia > 250;
  if (restante > 0) {
    $('alerta-cuenta').textContent = `${Math.ceil(restante)} s`;
    $('alerta-texto').textContent = lejos
      ? `Sismo lejano (a ${alertaActual.distancia.toFixed(0)} km). Puede sentirse leve.`
      : `La sacudida fuerte llega en ${Math.ceil(restante)} segundos · origen a ${alertaActual.distancia.toFixed(0)} km`;
  } else {
    $('alerta-cuenta').textContent = '¡AHORA!';
    $('alerta-texto').textContent = 'Protégete ya. Cuando pase, sal con calma y reporta daños.';
  }
  const ahora = Date.now();
  if (restante > -10 && ahora - ultimoPitido > (restante > 0 ? 1000 : 500)) {
    pitar(0.3, restante > 0 ? 880 : 1200);
    ultimoPitido = ahora;
  }
  if (restante < -90) cerrarAlerta();
}

function cerrarAlerta() {
  $('alerta-sismo').hidden = true;
  clearInterval(temporizadorAlerta);
}

function alertaZona(msg) {
  const mia = msg.zona === cfg.zona;
  const div = document.createElement('div');
  div.className = `alerta-zona ${msg.nivel} ${mia ? 'mia' : ''}`;
  div.innerHTML = `<b>${mia ? '⚠️ TU ZONA · ' : ''}${VIGIA.esc(msg.zona_nombre)}</b>
    <span>${VIGIA.esc(msg.mensaje)}</span><small>${VIGIA.hora(msg.t)}</small>`;
  div.addEventListener('click', () => div.remove());
  $('alertas-zona').prepend(div);
  while ($('alertas-zona').children.length > 3) $('alertas-zona').lastChild.remove();
  if (mia) {
    pitar(0.5, 660);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  }
}

// ---------- Inicio ----------
function pintarConexion(ok) {
  $('conexion').textContent = ok ? '● En línea' : '○ Sin conexión';
  $('conexion').className = `pastilla ${ok ? 'ok' : 'mal'}`;
}

async function iniciar() {
  catalogo = await VIGIA.catalogo();
  $('zona').innerHTML = catalogo.lugares.map((l) => `<option value="${l.id}">${VIGIA.esc(l.nombre)}</option>`).join('');
  $('zona').value = cfg.zona;
  $('numero-sms').value = cfg.numeroSms;
  if (cfg.lat !== null) $('txt-gps').textContent = `GPS: ${cfg.lat.toFixed(4)}, ${cfg.lng.toFixed(4)}`;

  $('tipos').innerHTML = Object.entries(catalogo.tipos_reporte).map(([k, t]) =>
    `<button class="tipo tipo-${k}" data-tipo="${k}"><span>${t.emoji}</span>${VIGIA.esc(t.nombre)}</button>`).join('');
  $('tipos').addEventListener('click', (e) => {
    const boton = e.target.closest('[data-tipo]');
    if (boton) elegirTipo(boton.dataset.tipo);
  });

  $('zona').addEventListener('change', () => {
    cfg.zona = $('zona').value;
    cfg.lat = cfg.lng = null;
    $('txt-gps').textContent = '';
    guardarCfg();
  });
  $('btn-gps').addEventListener('click', () => {
    if (!navigator.geolocation) { $('txt-gps').textContent = 'Sin GPS en este navegador'; return; }
    $('txt-gps').textContent = 'Buscando…';
    navigator.geolocation.getCurrentPosition((pos) => {
      cfg.lat = pos.coords.latitude;
      cfg.lng = pos.coords.longitude;
      cfg.zona = VIGIA.lugarMasCercano(catalogo.lugares, cfg.lat, cfg.lng).id;
      $('zona').value = cfg.zona;
      $('txt-gps').textContent = `GPS: ${cfg.lat.toFixed(4)}, ${cfg.lng.toFixed(4)}`;
      guardarCfg();
    }, (err) => { $('txt-gps').textContent = 'No se pudo: ' + err.message; }, { enableHighAccuracy: true, timeout: 15000 });
  });
  $('btn-alertas').addEventListener('click', activarSonido);
  $('menos').addEventListener('click', () => { $('personas').value = Math.max(1, Number($('personas').value) - 1); actualizarEnlaceSms(); });
  $('mas').addEventListener('click', () => { $('personas').value = Number($('personas').value) + 1; actualizarEnlaceSms(); });
  $('foto').addEventListener('change', async () => {
    const archivo = $('foto').files[0];
    if (!archivo) return;
    fotoActual = await comprimirFoto(archivo);
    if (fotoActual) { $('vista-foto').src = fotoActual; $('vista-foto').hidden = false; }
  });
  $('btn-enviar').addEventListener('click', enviarReporte);
  $('btn-sms').addEventListener('click', () => {
    // El SMS lo abre el propio celular; aquí solo lo dejamos registrado.
    agregarAlHistorial(nuevoReporte(), 'sms');
    setTimeout(volverAlInicio, 300);
  });
  $('btn-cancelar').addEventListener('click', volverAlInicio);
  $('numero-sms').addEventListener('change', () => { cfg.numeroSms = $('numero-sms').value.trim(); guardarCfg(); });
  $('alerta-cerrar').addEventListener('click', cerrarAlerta);

  conexion = VIGIA.conectar('comunidad', {
    alMensaje: (msg) => {
      if (msg.tipo === 'alerta_sismo') alertaSismo(msg);
      if (msg.tipo === 'alerta_zona') alertaZona(msg);
    },
    alCambiarConexion: (ok) => { pintarConexion(ok); if (ok) vaciarCola(); },
  });
  pintarConexion(false);
  window.addEventListener('online', vaciarCola);
  setInterval(vaciarCola, 5000);
  pintarHistorial();
}

iniciar();
