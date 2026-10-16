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
// La sirena es un WAV generado aquí y reproducido con <audio>: a diferencia de
// Web Audio, en iPhone suena aunque el interruptor de silencio esté activado.
// Los navegadores solo dejan sonar audio después de un toque del usuario, por
// eso hay que tocar "Activar alertas" una vez cada vez que se abre la página.
function crearSirena() {
  const tasa = 22050;
  const segundos = 2;
  const n = tasa * segundos;
  const datos = new DataView(new ArrayBuffer(44 + n * 2));
  const texto = (pos, s) => [...s].forEach((c, i) => datos.setUint8(pos + i, c.charCodeAt(0)));
  texto(0, 'RIFF'); datos.setUint32(4, 36 + n * 2, true); texto(8, 'WAVE');
  texto(12, 'fmt '); datos.setUint32(16, 16, true); datos.setUint16(20, 1, true); datos.setUint16(22, 1, true);
  datos.setUint32(24, tasa, true); datos.setUint32(28, tasa * 2, true); datos.setUint16(32, 2, true); datos.setUint16(34, 16, true);
  texto(36, 'data'); datos.setUint32(40, n * 2, true);
  let fase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / tasa;
    const frecuencia = 650 + 450 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 1 * t)); // sube y baja como sirena
    fase += (2 * Math.PI * frecuencia) / tasa;
    const muestra = 0.55 * Math.sin(fase) + 0.25 * Math.sin(3 * fase); // armónico para que se oiga más fuerte
    datos.setInt16(44 + i * 2, Math.max(-1, Math.min(1, muestra)) * 32767, true);
  }
  return URL.createObjectURL(new Blob([datos.buffer], { type: 'audio/wav' }));
}

const sirena = new Audio(crearSirena());
sirena.loop = true;
let sonidoActivo = false;
let bloqueoPantalla = null;

async function activarSonido() {
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback'; // Safari: ignorar el modo silencio
    sirena.volume = 1;
    await sirena.play();
    setTimeout(() => { if (!alertaActual) detenerSirena(); }, 700); // pitido corto de confirmación
    sonidoActivo = true;
    hablar('Alertas activadas');
    $('btn-alertas').textContent = '🔔 Alertas con sonido activadas';
    $('btn-alertas').classList.add('activo');
    $('aviso-sonido').hidden = true;
    mantenerPantalla();
  } catch (e) {
    $('btn-alertas').textContent = '🔇 No se pudo activar el sonido. Toca de nuevo';
  }
}

function sonarSirena(segundos) {
  if (!sonidoActivo) return;
  sirena.currentTime = 0;
  sirena.play().catch(() => { $('alerta-sonido').hidden = false; });
  if (segundos) setTimeout(() => { if (!alertaActual) detenerSirena(); }, segundos * 1000);
}

function detenerSirena() {
  sirena.pause();
  sirena.currentTime = 0;
}

function hablar(texto) {
  if (!('speechSynthesis' in window)) return;
  const frase = new SpeechSynthesisUtterance(texto);
  frase.lang = 'es-ES';
  frase.rate = 1.05;
  speechSynthesis.cancel();
  speechSynthesis.speak(frase);
}

async function mantenerPantalla() {
  // Con la pantalla bloqueada el navegador pausa la página y no puede sonar.
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') bloqueoPantalla = await navigator.wakeLock.request('screen');
  } catch (e) { /* no disponible */ }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && sonidoActivo) mantenerPantalla();
});

function probarAlerta() {
  if (!sonidoActivo) activarSonido();
  const pos = miPosicion();
  alertaSismo({ tipo: 'alerta_sismo', id: 'prueba-' + Date.now(), lat: pos.lat, lng: pos.lng, t0: VIGIA.ahora() + 10000, vs: 3.5, n_nodos: 1, prueba: true });
}

function alertaSismo(msg) {
  const nueva = !alertaActual || alertaActual.id !== msg.id;
  const pos = miPosicion();
  const distancia = VIGIA.distanciaKm(pos.lat, pos.lng, msg.lat, msg.lng);
  alertaActual = { ...msg, distancia, llegadaS: msg.t0 + (distancia / msg.vs) * 1000 };
  $('alerta-sismo').hidden = false;
  $('alerta-titulo').textContent = msg.prueba ? '⚠️ PRUEBA DE ALERTA' : '⚠️ SISMO DETECTADO';
  $('alerta-sonido').hidden = sonidoActivo;
  if (nueva) {
    if (navigator.vibrate) navigator.vibrate([600, 200, 600, 200, 600, 200, 600]); // Android; iPhone no vibra desde la web
    sonarSirena();
    const segundos = Math.ceil((alertaActual.llegadaS - VIGIA.ahora()) / 1000);
    hablar(segundos > 1
      ? `${msg.prueba ? 'Prueba. ' : ''}Sismo detectado. La sacudida llega en ${segundos} segundos. Agáchate, cúbrete y sujétate.`
      : `${msg.prueba ? 'Prueba. ' : ''}Sismo. Protégete ahora.`);
    clearInterval(temporizadorAlerta);
    temporizadorAlerta = setInterval(tickAlerta, 100);
  }
  tickAlerta();
}

let anuncioAhora = false;
function tickAlerta() {
  if (!alertaActual) return;
  const restante = (alertaActual.llegadaS - VIGIA.ahora()) / 1000;
  const lejos = alertaActual.distancia > 250;
  if (restante > 0) {
    anuncioAhora = false;
    $('alerta-cuenta').textContent = `${Math.ceil(restante)} s`;
    $('alerta-texto').textContent = lejos
      ? `Sismo lejano (a ${alertaActual.distancia.toFixed(0)} km). Puede sentirse leve.`
      : `La sacudida fuerte llega en ${Math.ceil(restante)} segundos · origen a ${alertaActual.distancia.toFixed(0)} km`;
  } else {
    $('alerta-cuenta').textContent = '¡AHORA!';
    $('alerta-texto').textContent = 'Protégete ya. Cuando pase, sal con calma y reporta daños.';
    if (!anuncioAhora) { anuncioAhora = true; hablar('Ahora. Protégete.'); }
  }
  if (restante < -20 && !sirena.paused) detenerSirena();
  if (restante < -90) cerrarAlerta();
}

function cerrarAlerta() {
  $('alerta-sismo').hidden = true;
  clearInterval(temporizadorAlerta);
  alertaActual = null;
  detenerSirena();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
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
    sonarSirena(3);
    hablar(`Alerta en tu zona. ${msg.mensaje}`);
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
  $('btn-probar').addEventListener('click', probarAlerta);
  $('alerta-sonido').addEventListener('click', async () => { await activarSonido(); sonarSirena(); $('alerta-sonido').hidden = true; });
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
