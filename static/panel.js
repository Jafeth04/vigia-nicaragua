// VIGÍA · Centro de coordinación (COMUPRED / COE)
// Separado por desastre natural: deslizamientos, sismos e inundaciones, más una
// vista de población y recursos (reportes de vecinos, prioridades y unidades).
// Cada tarjeta de arriba muestra el estado de su desastre; al elegirla, el mapa
// y la columna derecha muestran solo lo de ese desastre.

const $ = (id) => document.getElementById(id);
const COLOR = { verde: '#2ecc71', amarillo: '#f5b83d', rojo: '#ff4b4b', caido: '#6b7684' };
const NOMBRE_ESTADO = { verde: 'Normal', amarillo: 'Atención', rojo: 'Alerta', caido: 'Sin respuesta' };
const CLASE_ESTADO = { verde: 'ok', amarillo: 'warn', rojo: 'crit', caido: 'off' };
const CLASE_NIVEL = { normal: 'ok', atencion: 'warn', alerta: 'crit' };
const RANGO_CLASE = { off: 0, ok: 1, warn: 2, crit: 3 };
const NOMBRE_ROL = { A: 'A · ladera alta', B: 'B · ladera media', R: 'R · referencia' };
const REPORTES_GRAVES = new Set(['atrapados', 'heridos', 'deslizamiento']);
const ICONO_LUGAR = { escuela: 'school', hospital: 'hospital', asilo: 'hospital', edificio: 'store', puente: 'construction' };
const AMENAZAS = ['deslizamiento', 'sismo', 'inundacion', 'poblacion'];
const ETIQUETAS = {
  inclinacion: ['Inclinación', '°'], sacudida: ['Sacudida ahora', 'm/s²'], pga: ['Pico de sacudida', 'm/s²'],
  sta_lta: ['STA/LTA', ''], vel_inclinacion: ['Velocidad', '°/min'], vibracion: ['Vibración', 'm/s²'],
  nivel_cm: ['Nivel del agua', 'cm'], vel_nivel: ['Subida', 'cm/min'],
  ruido: ['Ruido de fondo', 'm/s²'], hz: ['Lecturas/s', ''],
};

let catalogo = null;
let estado = null;
const marcadoresNodo = new Map();
const marcadoresReporte = new Map();
let sismo = null;

const CLAVE_VISTA = 'vigia-panel-vista';
let seleccion = VIGIA.leer(CLAVE_VISTA, 'deslizamiento');
if (!AMENAZAS.includes(seleccion)) seleccion = 'deslizamiento';
let ultimaInteraccion = 0; // si el operador eligió una vista hace poco, no se la cambiamos sola
const clasePrevia = {};

// Vista inicial: el norte, donde están las comunidades de ladera del piloto.
const mapa = L.map('mapa', { zoomControl: true }).setView([13.2, -86.15], 8);
// Mapa de OpenStreetMap (no pide clave); el CSS lo oscurece para el tema de centro de mando.
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'teselas-oscuras',
  attribution: '© OpenStreetMap',
}).addTo(mapa);
const capas = {
  zonas: L.layerGroup(),
  comunidades: L.layerGroup(),
  reportes: L.layerGroup().addTo(mapa),
  nodos: L.layerGroup().addTo(mapa),
  sismo: L.layerGroup(),
};

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const nombreZona = (id) => (catalogo.lugares.find((l) => l.id === id) || {}).nombre || id;
const amenazaDeNodo = (n) => (catalogo.modos[n.modo] || {}).amenaza || 'sismo';
const amenazaDeReporte = (r) => (catalogo.tipos_reporte[r.tipo] || {}).amenaza || null;
const verTodo = () => $('ver-todo').checked;

// ---------- Estado de cada desastre (tarjetas de arriba) ----------
function peor(clases) {
  return clases.reduce((a, b) => (RANGO_CLASE[b] > RANGO_CLASE[a] ? b : a), 'ok');
}

function resumenAmenazas() {
  const nodos = estado.nodos;
  const pendientes = estado.reportes.filter((r) => !r.atendido_por);
  const repPendientes = (amenaza) => pendientes.filter((r) => amenazaDeReporte(r) === amenaza);
  const conReportes = (amenaza, texto) => {
    const n = repPendientes(amenaza).length;
    return n ? `${texto} · ${plural(n, 'reporte de vecinos', 'reportes de vecinos')}` : texto;
  };

  // Deslizamientos: comunidades A/B/R y laderas sueltas
  const comunidades = estado.comunidades || [];
  const laderas = nodos.filter((n) => n.modo === 'ladera' && !n.comunidad);
  const clasesD = [...comunidades.map((c) => CLASE_NIVEL[c.nivel]), ...laderas.map((n) => CLASE_ESTADO[n.estado_efectivo])];
  if (repPendientes('deslizamiento').length) clasesD.push('warn');
  const enAlertaD = comunidades.filter((c) => c.nivel === 'alerta');
  const enAtencionD = comunidades.filter((c) => c.nivel === 'atencion');
  let d;
  if (!comunidades.length && !laderas.length) d = { clase: 'off', nivel: 'Sin sensores', res: 'Configura un celular como sensor A, B o R' };
  else {
    const clase = peor(clasesD);
    const res = enAlertaD.length ? `Alerta en ${enAlertaD.map((c) => c.nombre).join(', ')}`
      : enAtencionD.length ? `Atención en ${plural(enAtencionD.length, 'comunidad', 'comunidades')} · el comité verifica`
        : `${plural(comunidades.length, 'comunidad vigilada', 'comunidades vigiladas')}${laderas.length ? ` · ${plural(laderas.length, 'ladera', 'laderas')}` : ''}`;
    d = { clase, nivel: nombreClase(clase), res: conReportes('deslizamiento', res) };
  }

  // Sismos: sismo en curso o estructuras con daño
  const estructuras = nodos.filter((n) => n.modo === 'estructura');
  let s;
  if (estado.sismo) {
    const cerca = VIGIA.lugarMasCercano(catalogo.lugares, estado.sismo.lat, estado.sismo.lng).nombre;
    s = { clase: 'crit', nivel: 'Sismo en curso', res: `Epicentro cerca de ${cerca} · ${plural(estado.sismo.n_nodos, 'nodo', 'nodos')}` };
  } else if (!estructuras.length) {
    s = { clase: 'off', nivel: 'Sin sensores', res: 'Ningún celular vigila estructuras' };
  } else {
    const clases = estructuras.map((n) => CLASE_ESTADO[n.estado_efectivo]);
    if (repPendientes('sismo').length) clases.push('warn');
    const clase = peor(clases);
    const conProblema = estructuras.filter((n) => n.estado_efectivo === 'rojo' || n.estado_efectivo === 'amarillo').length;
    const caidas = estructuras.filter((n) => n.estado_efectivo === 'caido').length;
    s = {
      clase,
      nivel: nombreClase(clase),
      res: conReportes('sismo', conProblema ? `${plural(conProblema, 'estructura con daños', 'estructuras con daños')}${caidas ? ` · ${caidas} sin respuesta` : ''}`
        : `${plural(estructuras.length, 'estructura vigilada', 'estructuras vigiladas')}${caidas ? ` · ${caidas} sin respuesta` : ''}`),
    };
  }

  // Inundaciones: ríos
  const rios = nodos.filter((n) => n.modo === 'rio');
  let i;
  if (!rios.length) i = { clase: 'off', nivel: 'Sin sensores', res: 'Ningún celular vigila ríos' };
  else {
    const clases = rios.map((n) => CLASE_ESTADO[n.estado_efectivo]);
    if (repPendientes('inundacion').length) clases.push('warn');
    const clase = peor(clases);
    const masAlto = [...rios].sort((a, b) => ((b.valores || {}).nivel_cm || 0) - ((a.valores || {}).nivel_cm || 0))[0];
    const nivelCm = (masAlto.valores || {}).nivel_cm;
    i = {
      clase,
      nivel: nombreClase(clase),
      res: conReportes('inundacion', masAlto.estado_efectivo === 'verde' || nivelCm == null ? plural(rios.length, 'río vigilado', 'ríos vigilados')
        : `${masAlto.nombre}: ${nivelCm >= 0 ? '+' : ''}${Number(nivelCm).toFixed(0)} cm`),
    };
  }

  // Población: pedidos sin atender y unidades libres
  const personas = pendientes.reduce((t, r) => t + r.personas, 0);
  const libresTot = estado.recursos.filter((r) => !r.zona).length;
  const claseP = pendientes.some((r) => REPORTES_GRAVES.has(r.tipo)) ? 'crit' : pendientes.length ? 'warn' : 'ok';
  const p = {
    clase: claseP,
    nivel: pendientes.length ? plural(pendientes.length, 'pedido', 'pedidos') : 'Sin pedidos',
    res: `${pendientes.length ? `${plural(personas, 'persona', 'personas')} por atender · ` : ''}${libresTot}/${estado.recursos.length} unidades libres`,
  };
  return { deslizamiento: d, sismo: s, inundacion: i, poblacion: p };
}

function nombreClase(clase) {
  return { ok: 'Normal', warn: 'Atención', crit: 'Alerta', off: 'Sin sensores' }[clase];
}

function pintarAmenazas() {
  const res = resumenAmenazas();
  for (const a of AMENAZAS) {
    const tab = $(`tab-${a}`);
    const r = res[a];
    tab.dataset.nivel = r.clase;
    tab.querySelector('.amenaza-nivel').textContent = r.nivel;
    tab.querySelector('.amenaza-res').textContent = r.res;
    // Si un desastre pasa a Alerta, el panel lo muestra solo (salvo que el operador esté trabajando en otra vista).
    if (clasePrevia[a] && clasePrevia[a] !== 'crit' && r.clase === 'crit' && a !== 'poblacion'
        && Date.now() - ultimaInteraccion > 20000) {
      seleccionar(a, { volar: a !== 'sismo' });
    }
    clasePrevia[a] = r.clase;
  }
  pintarEstadoGeneral(res);
}

function pintarEstadoGeneral(res) {
  const general = $('estado-general');
  const comunidades = estado.comunidades || [];
  const enAlerta = comunidades.filter((c) => c.nivel === 'alerta').length;
  const criticos = ['deslizamiento', 'sismo', 'inundacion'].filter((a) => res[a].clase === 'crit');
  const atencion = ['deslizamiento', 'sismo', 'inundacion'].filter((a) => res[a].clase === 'warn');
  const NOMBRE = { deslizamiento: 'deslizamiento', sismo: 'sismo', inundacion: 'inundación' };
  if (estado.sismo) {
    general.className = 'estado-general crit';
    general.textContent = 'Sismo en curso';
  } else if (enAlerta) {
    general.className = 'estado-general crit';
    general.textContent = enAlerta === 1 ? 'Alerta de deslizamiento' : `${enAlerta} alertas de deslizamiento`;
  } else if (criticos.length) {
    general.className = 'estado-general crit';
    general.textContent = `Alerta de ${criticos.map((a) => NOMBRE[a]).join(' y ')}`;
  } else if (atencion.length || res.poblacion.clase !== 'ok') {
    general.className = 'estado-general warn';
    general.textContent = atencion.length ? `Atención: ${atencion.map((a) => NOMBRE[a]).join(', ')}` : 'Pedidos por atender';
  } else {
    general.className = 'estado-general ok';
    general.textContent = 'Sin eventos';
  }
}

// ---------- Cambiar de vista ----------
function seleccionar(amenaza, { volar = false, manual = false } = {}) {
  seleccion = amenaza;
  if (manual) ultimaInteraccion = Date.now();
  VIGIA.guardar(CLAVE_VISTA, amenaza);
  document.querySelectorAll('.amenaza').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.amenaza === amenaza)));
  document.querySelectorAll('.vista').forEach((v) => { v.hidden = v.dataset.vista !== amenaza; });
  $('lateral').setAttribute('aria-labelledby', `tab-${amenaza}`);
  pintarLeyenda();
  if (sismo) $('banner-sismo').hidden = amenaza === 'sismo';
  if (estado) {
    filtrarMapa();
    if (volar) encuadrar();
  }
}

// Acerca el mapa a lo que pertenece a la vista elegida.
function encuadrar() {
  const puntos = [];
  if (seleccion === 'poblacion') {
    estado.reportes.filter((r) => !r.atendido_por).forEach((r) => puntos.push([r.lat, r.lng]));
  } else {
    estado.nodos.filter((n) => amenazaDeNodo(n) === seleccion).forEach((n) => puntos.push([n.lat, n.lng]));
    estado.reportes.filter((r) => amenazaDeReporte(r) === seleccion).forEach((r) => puntos.push([r.lat, r.lng]));
    if (seleccion === 'sismo' && sismo) puntos.push([sismo.lat, sismo.lng]);
  }
  if (!puntos.length) return;
  if (puntos.length === 1) mapa.flyTo(puntos[0], 13);
  else mapa.flyToBounds(L.latLngBounds(puntos).pad(0.25), { maxZoom: 13 });
}

function filtrarMapa() {
  const todo = verTodo();
  const ver = (amenaza) => todo || amenaza === seleccion;
  const capa = (grupo, visible) => {
    if (visible && !mapa.hasLayer(grupo)) grupo.addTo(mapa);
    if (!visible && mapa.hasLayer(grupo)) mapa.removeLayer(grupo);
  };
  capa(capas.comunidades, ver('deslizamiento'));
  capa(capas.sismo, ver('sismo'));
  capa(capas.zonas, ver('poblacion'));
  for (const n of estado.nodos) {
    const m = marcadoresNodo.get(n.id);
    if (!m) continue;
    const visible = ver(amenazaDeNodo(n));
    if (visible && !capas.nodos.hasLayer(m)) capas.nodos.addLayer(m);
    if (!visible && capas.nodos.hasLayer(m)) capas.nodos.removeLayer(m);
  }
  for (const r of estado.reportes) {
    const m = marcadoresReporte.get(r.id);
    if (!m) continue;
    const visible = todo || seleccion === 'poblacion' || amenazaDeReporte(r) === seleccion;
    if (visible && !capas.reportes.hasLayer(m)) capas.reportes.addLayer(m);
    if (!visible && capas.reportes.hasLayer(m)) capas.reportes.removeLayer(m);
  }
}

function pintarLeyenda() {
  const estados = `<b>Sensores</b>
    <span><i class="punto" style="background:var(--ok)"></i>Normal</span>
    <span><i class="punto" style="background:var(--warn)"></i>Atención</span>
    <span><i class="punto" style="background:var(--crit)"></i>Alerta</span>
    <span><i class="punto" style="background:var(--off)"></i>Sin respuesta</span>
    <span><i class="punto real" style="background:var(--raised)"></i>Celular real (borde celeste)</span>`;
  const reporte = `<b>Reportes de vecinos</b>
    <span><span class="mini-reporte grave">${icono('siren')}</span>Grave (atrapados, heridos, deslizamiento)</span>
    <span><span class="mini-reporte">${icono('droplets')}</span>Otros pedidos</span>`;
  const extra = {
    deslizamiento: `<b>Comunidades</b>
      <span><i class="aro"></i>Círculo: comunidad (color = su estado)</span>
      <span><b class="letra">A B R</b>Posición de cada sensor</span>`,
    sismo: `<b>Sismo</b>
      <span><i class="linea-p"></i>Onda P (rápida, da el aviso)</span>
      <span><i class="linea-s"></i>Onda S (fuerte, causa daño)</span>
      <span><i class="aro amb"></i>Zona probable del epicentro</span>`,
    inundacion: '',
    poblacion: `<b>Zonas por atender</b>
      <span><i class="aro crit"></i>Prioridad crítica</span>
      <span><i class="aro naranja"></i>Prioridad alta</span>
      <span><i class="aro amb"></i>Prioridad media</span>`,
  }[seleccion];
  $('leyenda-contenido').innerHTML = seleccion === 'poblacion' ? `${extra}${reporte}` : `${estados}${extra}${reporte}`;
}

// ---------- Nodos en el mapa ----------
function popupNodo(n) {
  const modo = catalogo.modos[n.modo];
  const valores = Object.entries(n.valores || {}).map(([k, v]) => {
    const [nombre, unidad] = ETIQUETAS[k] || [k, ''];
    return `<tr><td>${nombre}</td><td>${Number(v).toFixed(2)} ${unidad}</td></tr>`;
  }).join('');
  const hace = Math.max(0, Math.round((estado.ahora - n.ultimo_contacto) / 1000));
  const comunidad = n.comunidad ? (estado.comunidades || []).find((c) => c.id === n.comunidad) : null;
  const calibraciones = (n.calibraciones || []).slice(-4).map((c) =>
    `<tr><td>Prueba ${c.real}°</td><td>${c.medido}° (${c.error >= 0 ? '+' : ''}${c.error}°)</td></tr>`).join('');
  return `<div class="popup">
    <b class="con-ico">${icono(modo.icono)}${VIGIA.esc(n.nombre)}</b>
    <span><span class="etq ${CLASE_ESTADO[n.estado_efectivo]}">${NOMBRE_ESTADO[n.estado_efectivo]}</span>
      <small>${n.simulado ? 'Nodo simulado' : 'Celular real'} · ${modo.nombre}</small></span>
    ${n.rol ? `<small>Sensor ${NOMBRE_ROL[n.rol]} de ${VIGIA.esc(comunidad ? comunidad.nombre : n.comunidad)}</small>` : ''}
    ${calibraciones ? `<table>${calibraciones}</table>` : ''}
    ${n.motivo ? `<span>${VIGIA.esc(n.motivo)}</span>` : ''}
    ${valores ? `<table>${valores}</table>` : ''}
    <small>${n.personas} personas · ${n.bateria != null ? `batería ${n.bateria}% · ` : ''}contacto hace ${hace} s</small>
    ${n.atendido_por ? `<span class="con-ico ok">${icono('circle-check')}Atendido por ${VIGIA.esc(n.atendido_por)}</span>` : ''}
    <button class="btn btn-pequeno" onclick="restablecerNodo('${VIGIA.esc(n.id)}')">${icono('rotate-ccw')}Restablecer alarma</button>
  </div>`;
}

function pintarNodos() {
  const vistos = new Set();
  for (const n of estado.nodos) {
    vistos.add(n.id);
    let m = marcadoresNodo.get(n.id);
    if (!m) {
      m = L.circleMarker([n.lat, n.lng], { weight: 3, fillOpacity: 1 });
      m.bindPopup('');
      if (n.rol) m.bindTooltip(n.rol, { permanent: true, direction: 'right', offset: [8, 0], className: 'etiqueta-rol' });
      marcadoresNodo.set(n.id, m);
    }
    m.setLatLng([n.lat, n.lng]);
    m.setStyle({
      radius: n.simulado ? 7 : 11,
      color: n.simulado ? '#0b1016' : '#46b9f5',
      weight: n.simulado ? 2 : 3,
      fillColor: COLOR[n.estado_efectivo],
    });
    m.setPopupContent(popupNodo(n));
  }
  for (const [id, m] of marcadoresNodo) {
    if (!vistos.has(id)) { capas.nodos.removeLayer(m); marcadoresNodo.delete(id); }
  }
}

// Acciones del panel protegidas con PIN (si el servidor lo tiene definido).
// El PIN se pide una vez y queda guardado en este navegador.
const CLAVE_PIN = 'vigia-pin-panel';
async function accion(url, datos = {}) {
  const cabeceras = () => ({ 'X-VIGIA-PIN': VIGIA.leer(CLAVE_PIN, '') });
  try {
    return await VIGIA.postJSON(url, datos, cabeceras());
  } catch (e) {
    if (e.status !== 401) throw e;
    const pin = prompt('PIN del panel (lo define quien administra VIGÍA):');
    if (!pin) throw new Error('Acción cancelada: falta el PIN del panel');
    VIGIA.guardar(CLAVE_PIN, pin.trim());
    return VIGIA.postJSON(url, datos, cabeceras());
  }
}

window.restablecerNodo = (id) => accion(`/api/nodos/${encodeURIComponent(id)}/restablecer`).catch(mostrarError);

// ---------- Reportes ----------
function popupReporte(r) {
  const t = catalogo.tipos_reporte[r.tipo];
  return `<div class="popup">
    <b class="con-ico">${icono(t.icono)}${VIGIA.esc(t.nombre)}</b>
    <span>${plural(r.personas, 'persona', 'personas')} · ${VIGIA.esc(r.lugar)}</span>
    ${r.descripcion ? `<i>${VIGIA.esc(r.descripcion)}</i>` : ''}
    <small>${VIGIA.hora(r.creado)} · vía ${VIGIA.esc(r.origen)}</small>
    ${r.tiene_foto ? `<img src="/api/reportes/${encodeURIComponent(r.id)}/foto" alt="Foto del reporte">` : ''}
    ${r.atendido_por ? `<span class="con-ico ok">${icono('circle-check')}Atendido por ${VIGIA.esc(r.atendido_por)}</span>` : ''}
  </div>`;
}

function pintarReportes() {
  const vistos = new Set();
  for (const r of estado.reportes) {
    vistos.add(r.id);
    const clase = `marcador-reporte${REPORTES_GRAVES.has(r.tipo) ? ' grave' : ''}${r.atendido_por ? ' atendido' : ''}`;
    const html = `<span class="${clase}">${icono(catalogo.tipos_reporte[r.tipo].icono)}</span>`;
    let m = marcadoresReporte.get(r.id);
    if (!m) {
      m = L.marker([r.lat, r.lng]);
      m.bindPopup('');
      m._html = '';
      marcadoresReporte.set(r.id, m);
    }
    if (m._html !== html) {
      m.setIcon(L.divIcon({ html, className: '', iconSize: [30, 30], iconAnchor: [15, 15] }));
      m.setPopupContent(popupReporte(r));
      m._html = html;
    }
  }
  for (const [id, m] of marcadoresReporte) {
    if (!vistos.has(id)) { capas.reportes.removeLayer(m); marcadoresReporte.delete(id); }
  }
}

// Lista compacta de reportes de un desastre (dentro de su vista).
function pintarListaReportes(amenaza) {
  const lista = estado.reportes.filter((r) => amenazaDeReporte(r) === amenaza).slice(-8).reverse();
  $(`bloque-rep-${amenaza}`).hidden = !lista.length;
  $(`rep-${amenaza}`).innerHTML = lista.map((r) => {
    const t = catalogo.tipos_reporte[r.tipo];
    return `<li class="fila ${r.atendido_por ? 'atendida' : REPORTES_GRAVES.has(r.tipo) ? 'crit' : 'warn'}" data-lat="${r.lat}" data-lng="${r.lng}">
      <span class="fila-ico">${icono(t.icono)}</span>
      <span class="fila-txt"><b>${VIGIA.esc(t.nombre)} · ${VIGIA.esc(nombreZona(r.zona))}</b>
        <small>${plural(r.personas, 'persona', 'personas')} · ${VIGIA.hora(r.creado)} · vía ${VIGIA.esc(r.origen)}</small></span>
      <span class="etq ${r.atendido_por ? 'ok' : 'warn'}">${r.atendido_por ? 'Atendido' : 'Pendiente'}</span>
    </li>`;
  }).join('');
}

// ---------- Filas de sensores (estructuras, ríos y laderas sueltas) ----------
function filaNodo(n, dato) {
  const clase = CLASE_ESTADO[n.estado_efectivo];
  const ico = n.modo === 'estructura' ? (ICONO_LUGAR[n.tipo_lugar] || 'building') : catalogo.modos[n.modo].icono;
  const puedeRestablecer = n.modo !== 'rio' && (n.estado_efectivo === 'rojo' || n.estado_efectivo === 'amarillo');
  const detalle = n.estado_efectivo === 'caido' ? 'No responde: revisar energía o señal'
    : n.motivo || `${nombreZona(n.zona)} · ${plural(n.personas, 'persona', 'personas')}`;
  return `<li class="fila ${clase}" data-lat="${n.lat}" data-lng="${n.lng}">
    <span class="fila-ico">${icono(ico)}</span>
    <span class="fila-txt"><b>${VIGIA.esc(n.nombre)}</b><small>${VIGIA.esc(detalle)}</small></span>
    ${dato ? `<span class="fila-dato mono">${dato}</span>` : ''}
    <span class="etq ${clase}">${NOMBRE_ESTADO[n.estado_efectivo]}</span>
    ${puedeRestablecer ? `<button class="btn btn-pequeno fila-accion" data-restablecer="${VIGIA.esc(n.id)}" title="Restablecer la alarma de este sensor">${icono('rotate-ccw')}</button>` : ''}
  </li>`;
}

const ordenSeveridad = (a, b) => ({ rojo: 0, amarillo: 1, caido: 2, verde: 3 }[a.estado_efectivo] - { rojo: 0, amarillo: 1, caido: 2, verde: 3 }[b.estado_efectivo]);

function pintarEstructuras() {
  const lista = estado.nodos.filter((n) => n.modo === 'estructura').sort(ordenSeveridad);
  $('estructuras').innerHTML = lista.map((n) => {
    const v = n.valores || {};
    const dato = v.pga ? `${Number(v.pga).toFixed(1)} m/s²` : v.inclinacion != null ? `${Number(v.inclinacion).toFixed(1)}°` : '';
    return filaNodo(n, dato);
  }).join('') || '<li class="vacio">Ningún celular vigila estructuras. Configura uno en modo «Estructura» o simula un sismo.</li>';
}

function pintarRios() {
  const lista = estado.nodos.filter((n) => n.modo === 'rio').sort(ordenSeveridad);
  $('rios').innerHTML = lista.map((n) => {
    const v = n.valores || {};
    const nivel = v.nivel_cm != null ? `${v.nivel_cm >= 0 ? '+' : ''}${Number(v.nivel_cm).toFixed(0)} cm` : '';
    const sube = v.vel_nivel > 0.05 ? `<small>sube ${Number(v.vel_nivel).toFixed(1)} cm/min</small>` : '';
    return filaNodo(n, nivel ? `<span>${nivel}</span>${sube}` : '');
  }).join('') || '<li class="vacio">Ningún celular vigila ríos. Configura uno en modo «Río» o simula una lluvia intensa.</li>';
}

function pintarLaderasSueltas() {
  const lista = estado.nodos.filter((n) => n.modo === 'ladera' && !n.comunidad).sort(ordenSeveridad);
  $('bloque-laderas').hidden = !lista.length;
  $('laderas').innerHTML = lista.map((n) => {
    const v = n.valores || {};
    return filaNodo(n, v.inclinacion != null ? `${Number(v.inclinacion).toFixed(1)}°` : '');
  }).join('');
}

// ---------- Comunidades de ladera (A, B y R) ----------
function filaSensor(rol, s) {
  if (!s) return `<div class="sensor-rol off"><span class="rol">${rol}</span><span>No instalado</span></div>`;
  if (!s.conectado) return `<div class="sensor-rol off"><span class="rol">${rol}</span><span>Sin respuesta</span><small>${VIGIA.esc(s.nombre)}</small></div>`;
  const pilaBaja = typeof s.bateria === 'number' && s.bateria < 20;
  const pila = pilaBaja ? `<small class="pila">${icono('battery-low')}${s.bateria}%</small>` : '';
  let clase;
  let texto;
  let datos;
  if (rol === 'R') {
    [clase, texto] = s.vibra ? ['warn', 'Vibra: sismo'] : s.inclinacion >= 1 ? ['warn', 'Movida: revisar'] : ['ok', 'Estable'];
    datos = `${s.inclinacion.toFixed(2)}°<br>vib ${s.vibracion.toFixed(2)}`;
  } else {
    [clase, texto] = s.movimiento ? ['crit', 'Se mueve'] : s.en_observacion ? ['warn', 'En observación'] : ['ok', 'Quieto'];
    datos = `${s.inclinacion_compensada.toFixed(2)}°<br>${s.velocidad.toFixed(1)}°/min`;
  }
  if (pilaBaja && clase === 'ok') clase = 'warn';
  return `<div class="sensor-rol ${clase}"><span class="rol">${rol}</span><span>${texto}</span>
    <small class="mono">${datos}</small>${pila}</div>`;
}

// Gráfica de los últimos 5 minutos: si A y B se separan de R, se mueve la ladera.
function graficaTendencia(tendencia) {
  const W = 300;
  const H = 74;
  const series = [['A', 'tend-a'], ['B', 'tend-b'], ['R', 'tend-r']].filter(([rol]) => (tendencia[rol] || []).length > 1);
  if (!series.length) return '';
  // La ventana se ajusta a los datos que hay: mínimo 1 minuto, máximo 5.
  const masViejo = Math.max(...series.flatMap(([rol]) => tendencia[rol].map((p) => p[0])));
  const VENTANA = Math.max(60, Math.min(300, masViejo));
  const valores = series.flatMap(([rol]) => tendencia[rol].map((p) => p[1]));
  const maxY = Math.max(1.2, Math.max(...valores) * 1.15);
  const x = (seg) => W - (Math.min(seg, VENTANA) / VENTANA) * W;
  const y = (g) => H - 4 - (Math.max(0, g) / maxY) * (H - 10);
  const lineas = series.map(([rol, clase]) => {
    const puntos = tendencia[rol].map(([seg, g]) => `${x(seg).toFixed(1)},${y(g).toFixed(1)}`).join(' ');
    return `<polyline class="${clase}" points="${puntos}"/>`;
  }).join('');
  const umbral = y(0.5);
  return `<figure class="tendencia">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Inclinación de A, B y R en los últimos 5 minutos">
      <line class="tend-umbral" x1="0" x2="${W}" y1="${umbral.toFixed(1)}" y2="${umbral.toFixed(1)}"/>
      <text class="tend-texto" x="${W - 2}" y="${(umbral - 3).toFixed(1)}" text-anchor="end">0,5° límite</text>
      ${lineas}
    </svg>
    <figcaption><span class="ley-a">A</span><span class="ley-b">B</span><span class="ley-r">R</span><span>inclinación · últimos ${VENTANA >= 120 ? `${Math.round(VENTANA / 60)} min` : `${VENTANA} s`} · máx ${maxY.toFixed(1)}°</span></figcaption>
  </figure>`;
}

function botonesComite(c) {
  if (c.decision === 'confirmada') {
    return `<div class="acciones-zona"><button class="btn btn-pequeno" data-decision="terminar" data-com-id="${c.id}">${icono('circle-check')}Terminar la alerta confirmada</button></div>`;
  }
  if (c.nivel !== 'atencion') return '';
  return `<div class="comite">
    <p>${icono('users')}El comité fue al sitio. ¿Qué encontró?</p>
    <div class="acciones-zona">
      <button class="btn btn-pequeno btn-ok" data-decision="falsa" data-com-id="${c.id}">${icono('check')}Falsa alarma</button>
      <button class="btn btn-pequeno btn-peligro" data-decision="confirmar" data-com-id="${c.id}">${icono('triangle-alert')}Hay daños: dar Alerta</button>
    </div>
  </div>`;
}

function pintarComunidades() {
  const comunidades = estado.comunidades || [];
  capas.comunidades.clearLayers();
  comunidades.forEach((c) => {
    L.circle([c.lat, c.lng], {
      radius: 450, weight: 2, fillOpacity: c.nivel === 'normal' ? 0.06 : 0.2,
      color: { normal: COLOR.verde, atencion: COLOR.amarillo, alerta: COLOR.rojo }[c.nivel],
    }).bindTooltip(`${c.nombre} · ${c.nombre_nivel}`).addTo(capas.comunidades);
  });
  $('comunidades').innerHTML = comunidades.map((c) => {
    const aviso = c.avisos.length ? c.avisos[c.avisos.length - 1] : null;
    const hace = c.desde ? Math.max(0, Math.round((estado.ahora - c.desde) / 60000)) : null;
    const nombreAviso = { alerta: 'Alerta', atencion: 'Atención', normal: 'Fin del aviso' }[aviso && aviso.nivel] || 'Aviso';
    return `<article class="com nivel-${c.nivel}" data-com="${c.id}">
      <div class="com-cab">
        <div><b>${VIGIA.esc(c.nombre)}</b><small>${VIGIA.esc(c.zona_nombre)} · ${c.personas} personas${c.nivel !== 'normal' && hace !== null ? ` · desde hace ${hace} min` : ''}</small></div>
        <span class="etq ${CLASE_NIVEL[c.nivel]}">${c.nombre_nivel}</span>
      </div>
      ${c.motivos.length ? `<ul class="razones">${c.motivos.slice(0, 3).map((m) => `<li>${VIGIA.esc(m)}</li>`).join('')}</ul>` : ''}
      <div class="trio">${['A', 'B', 'R'].map((rol) => filaSensor(rol, c.sensores[rol])).join('')}</div>
      ${graficaTendencia(c.tendencia || {})}
      ${botonesComite(c)}
      ${aviso ? `<p class="com-aviso">${icono('send')}<span>${nombreAviso}: aviso al ${VIGIA.esc(aviso.destino)} · ${VIGIA.hora(aviso.t)} · SMS ${VIGIA.esc(aviso.sms)}</span></p>` : ''}
      ${c.atendido_por ? `<p class="com-aviso ok">${icono('truck')}<span>Atendida por ${VIGIA.esc(c.atendido_por)}</span></p>` : ''}
    </article>`;
  }).join('') || `<p class="vacio">No hay sensores de comunidad conectados. Configura un celular como sensor A, B o R,
    o abre «Simulación» y prueba un deslizamiento.</p>`;
}

// ---------- Prioridades ----------
function nivelPrioridad(relativo) {
  if (relativo > 0.66) return { clase: 'crit', nombre: 'Crítica', color: COLOR.rojo };
  if (relativo > 0.33) return { clase: 'warn', nombre: 'Alta', color: '#ff8a3d' };
  return { clase: 'info', nombre: 'Media', color: COLOR.amarillo };
}

function pintarZonas() {
  capas.zonas.clearLayers();
  const maximo = Math.max(1, ...estado.zonas.map((z) => z.puntaje));
  estado.zonas.forEach((z, i) => {
    if (z.puntaje <= 0) return;
    L.circle([z.lat, z.lng], {
      radius: 6000,
      color: nivelPrioridad(z.puntaje / maximo).color,
      weight: 2,
      fillOpacity: 0.14,
    }).bindTooltip(`#${i + 1} ${z.nombre} · ${z.puntaje}`).addTo(capas.zonas);
  });
}

function libres(tipo) {
  return estado.recursos.filter((r) => r.tipo === tipo && !r.zona).length;
}

function pintarRanking() {
  const maximo = Math.max(1, ...estado.zonas.map((z) => z.puntaje));
  let posicion = 0;
  $('ranking').innerHTML = estado.zonas.map((z) => {
    const activa = z.puntaje > 0;
    if (activa) posicion++;
    const nivel = nivelPrioridad(z.puntaje / maximo);
    const razones = z.explicacion.map((l) => `<li>${VIGIA.esc(l)}</li>`);
    const visibles = razones.slice(0, 3).join('');
    const ocultas = razones.slice(3);
    // El recurso más pedido va como botón principal; el resto, secundarios.
    const sugeridos = Object.entries(z.sugeridos).sort((a, b) => b[1] - a[1]);
    let principalPuesto = false;
    const acciones = sugeridos.map(([tipo, n]) => {
      const r = catalogo.recursos[tipo];
      const disponibles = libres(tipo);
      const principal = disponibles && !principalPuesto;
      if (principal) principalPuesto = true;
      return `<button class="btn btn-pequeno ${principal ? 'btn-primario' : 'btn-sec'} asignar" data-zona="${z.zona}" data-tipo="${tipo}" ${disponibles ? '' : 'disabled'}
        title="${disponibles ? `${plural(disponibles, 'unidad libre', 'unidades libres')}` : 'No quedan unidades libres'}">
        ${icono(r.icono)}Enviar ${VIGIA.esc(r.nombre.toLowerCase())}<small>${disponibles ? plural(n, 'pedido', 'pedidos') : 'sin unidades'}</small></button>`;
    }).join('');
    const enCamino = z.asignados.map((r) => `<span class="etq ok">${icono(catalogo.recursos[r.tipo].icono)}${VIGIA.esc(r.id)}</span>`).join('');
    return `<li class="zona ${activa && posicion === 1 ? 'primero' : ''} ${activa ? '' : 'atendida'}">
      <div class="zona-cab" data-ir="${z.zona}" title="Ver en el mapa">
        <span class="pos">${activa ? posicion : icono('check')}</span>
        <span class="zona-nombre"><b>${VIGIA.esc(z.nombre)}</b>
          <span class="etq ${activa ? nivel.clase : 'ok'}">${activa ? `Prioridad ${nivel.nombre.toLowerCase()}` : 'En atención'}</span></span>
        <span class="puntaje"><b>${Math.round(z.puntaje)}</b><small>puntos</small></span>
      </div>
      ${activa ? `<div class="barra-p"><i style="width:${(100 * z.puntaje) / maximo}%;background:${nivel.color}"></i></div>` : ''}
      <ul class="razones">${visibles}</ul>
      ${ocultas.length ? `<details class="mas-razones"><summary>Ver ${ocultas.length} motivo${ocultas.length === 1 ? '' : 's'} más</summary><ul class="razones">${ocultas.join('')}</ul></details>` : ''}
      ${acciones ? `<div class="acciones-zona">${acciones}</div>` : ''}
      ${enCamino ? `<div class="en-camino">En camino: ${enCamino}</div>` : ''}
    </li>`;
  }).join('') || '<li class="vacio">Sin pedidos ni alertas. Cuando lleguen reportes de vecinos, aquí verás a quién atender primero.</li>';
}

function pintarRecursos() {
  $('recursos').innerHTML = Object.entries(catalogo.recursos).map(([tipo, r]) => {
    const unidades = estado.recursos.filter((u) => u.tipo === tipo);
    const usadas = unidades.filter((u) => u.zona);
    const barra = unidades.map((u) => `<i class="${u.zona ? 'usado' : ''}"></i>`).join('');
    const chips = usadas.map((u) => `<span class="unidad">${VIGIA.esc(u.id)} → ${VIGIA.esc(nombreZona(u.zona))}
      <button class="liberar" data-recurso="${VIGIA.esc(u.id)}" title="Marcar como libre: el equipo volvió">Liberar</button></span>`).join('');
    return `<div class="recurso">
      <span class="recurso-ico">${icono(r.icono)}</span><span>${VIGIA.esc(r.nombre)}</span>
      <span class="recurso-num">${unidades.length - usadas.length}/${unidades.length} libres</span>
      <span class="recurso-barra">${barra}</span>
      ${chips ? `<span class="unidades">${chips}</span>` : ''}
    </div>`;
  }).join('');
}

// ---------- Bitácora (completa y por desastre) ----------
const ICONO_NIVEL = { rojo: 'triangle-alert', amarillo: 'circle-alert' };
function filaBitacora(b) {
  return `<li class="${b.nivel}"><span class="b-ico">${icono(b.icono || ICONO_NIVEL[b.nivel] || 'circle-dot')}</span><time>${VIGIA.hora(b.t)}</time><span>${VIGIA.esc(b.texto)}</span></li>`;
}

function pintarBitacora() {
  $('bitacora').innerHTML = estado.bitacora.map(filaBitacora).join('');
  for (const a of ['deslizamiento', 'sismo', 'inundacion']) {
    const propias = estado.bitacora.filter((b) => b.amenaza === a).slice(0, 8);
    $(`act-${a}`).innerHTML = propias.map(filaBitacora).join('') || '<li class="sin-actividad">Sin actividad reciente.</li>';
  }
}

// ---------- Sismo: ondas P y S ----------
function pintarSismo() {
  const ev = estado.sismo;
  if (!ev) {
    if (sismo && VIGIA.ahora() - sismo.t0 > 150000) quitarSismo();
    return;
  }
  if (!sismo || sismo.id !== ev.id) {
    quitarSismo();
    sismo = {
      id: ev.id,
      epicentro: L.marker([ev.lat, ev.lng], {
        icon: L.divIcon({ html: '<span class="epicentro"></span>', className: '', iconSize: [36, 36], iconAnchor: [18, 18] }),
      }).bindTooltip('Epicentro estimado').addTo(capas.sismo),
      circuloP: L.circle([ev.lat, ev.lng], { radius: 0, color: '#46b9f5', weight: 2, dashArray: '6 6', fill: false }).addTo(capas.sismo),
      circuloS: L.circle([ev.lat, ev.lng], { radius: 0, color: '#ff4b4b', weight: 3, fillOpacity: 0.08 }).addTo(capas.sismo),
      circuloIncertidumbre: L.circle([ev.lat, ev.lng], { radius: 0, color: '#f5b83d', weight: 1.5, dashArray: '3 6', fillOpacity: 0.07 })
        .bindTooltip('Zona probable del epicentro').addTo(capas.sismo),
      real: null,
    };
    seleccionar('sismo');
    mapa.flyTo([ev.lat, ev.lng], 8);
  }
  Object.assign(sismo, {
    lat: ev.lat, lng: ev.lng, t0: ev.t0, n: ev.n_nodos,
    incertidumbre: ev.incertidumbre_km, profundidad: ev.profundidad_km,
  });
  [sismo.epicentro, sismo.circuloP, sismo.circuloS, sismo.circuloIncertidumbre].forEach((capa) => capa.setLatLng([ev.lat, ev.lng]));
  sismo.circuloIncertidumbre.setRadius((ev.incertidumbre_km || 0) * 1000);

  // En las simulaciones se conoce el epicentro verdadero: se muestra para comparar.
  const real = estado.sismo_real;
  if (real && !sismo.real) {
    sismo.real = L.marker([real.lat, real.lng], {
      icon: L.divIcon({ html: `<span class="epicentro-real">${icono('x')}</span>`, className: '', iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).bindTooltip(`Epicentro real (simulación) · M${real.magnitud} · ${real.profundidad_km} km de profundidad`).addTo(capas.sismo);
    sismo.coordReal = real;
  }
}

function quitarSismo() {
  capas.sismo.clearLayers();
  sismo = null;
  $('banner-sismo').hidden = true;
  $('bloque-sismo-activo').hidden = true;
}

let ultimoBanner = 0;
function animarSismo() {
  requestAnimationFrame(animarSismo);
  if (!sismo || !estado) return;
  const transcurrido = (VIGIA.ahora() - sismo.t0) / 1000;
  sismo.circuloP.setRadius(Math.max(0, transcurrido * estado.vp * 1000));
  sismo.circuloS.setRadius(Math.max(0, transcurrido * estado.vs * 1000));
  if (Date.now() - ultimoBanner < 250) return;
  ultimoBanner = Date.now();

  const cercano = VIGIA.lugarMasCercano(catalogo.lugares, sismo.lat, sismo.lng);
  const llegadas = catalogo.lugares
    .map((l) => ({ l, d: VIGIA.distanciaKm(sismo.lat, sismo.lng, l.lat, l.lng) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 8)
    .map(({ l, d }) => {
      const falta = d / estado.vs - transcurrido;
      return falta > 0
        ? `<span class="llegada">${VIGIA.esc(l.nombre)} <b>${Math.ceil(falta)} s</b></span>`
        : `<span class="llegada llego">${VIGIA.esc(l.nombre)} ${icono('check')}</span>`;
    }).join('');
  const datos = [`Nodos que lo detectaron: <b>${sismo.n}</b>`];
  if (sismo.n === 1) {
    datos.push(`Con 1 nodo solo se sabe la distancia${sismo.incertidumbre ? `: <b>~${Math.round(sismo.incertidumbre)} km</b>` : ''}, no la dirección`);
  } else {
    datos.push(`Precisión: <b>±${Math.round(sismo.incertidumbre || 0)} km</b>`);
    if (sismo.profundidad) datos.push(`Profundidad: <b>~${sismo.profundidad} km</b>`);
  }
  if (sismo.coordReal) {
    const error = VIGIA.distanciaKm(sismo.lat, sismo.lng, sismo.coordReal.lat, sismo.coordReal.lng);
    datos.push(`<span class="error-real">Error vs. epicentro real: <b>${error.toFixed(1)} km</b></span>`);
  }
  const html = `
    <div class="sismo-titulo">${icono('activity')}<div><b>SISMO DETECTADO</b><span>Epicentro cerca de ${VIGIA.esc(cercano.nombre)} · hace ${Math.max(0, transcurrido).toFixed(0)} s</span></div></div>
    <div class="sismo-datos">${datos.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="llegadas">La sacudida fuerte llega a: ${llegadas}</div>`;
  // En la vista Sismos el detalle está en la columna derecha; en las demás, la franja de arriba avisa.
  $('banner-sismo').hidden = seleccion === 'sismo';
  $('banner-sismo').innerHTML = html;
  $('bloque-sismo-activo').hidden = false;
  $('sismo-activo').innerHTML = `<div class="sismo sismo-tarjeta">${html}</div>`;
}

// ---------- General ----------
function pintar() {
  pintarAmenazas();
  pintarComunidades();
  pintarLaderasSueltas();
  pintarEstructuras();
  pintarRios();
  pintarListaReportes('deslizamiento');
  pintarListaReportes('sismo');
  pintarListaReportes('inundacion');
  pintarNodos();
  pintarReportes();
  pintarZonas();
  pintarRanking();
  pintarRecursos();
  pintarBitacora();
  pintarSismo();
  filtrarMapa();
  $('modo-demo').checked = estado.modo_demo;
}

function mostrarError(e) {
  const li = document.createElement('li');
  li.className = 'rojo';
  li.innerHTML = `<span class="b-ico">${icono('triangle-alert')}</span><time>${VIGIA.hora(Date.now())}</time><span></span>`;
  li.lastChild.textContent = e.message;
  document.querySelectorAll('.vista:not([hidden]) .bitacora').forEach((ul) => ul.prepend(li.cloneNode(true)));
  $('bitacora').prepend(li);
}

function alternarSimulacion(abrir) {
  const abierto = abrir ?? $('simulacion').hidden;
  $('simulacion').hidden = !abierto;
  $('btn-simulacion').setAttribute('aria-expanded', String(abierto));
}

let confirmarReinicio = null;
const TEXTO_REINICIAR = `${icono('rotate-ccw')}Reiniciar todo`;
function reiniciar() {
  const boton = $('btn-reiniciar');
  if (!confirmarReinicio) {
    boton.innerHTML = `${icono('triangle-alert')}¿Seguro? Toca otra vez para borrar todo`;
    confirmarReinicio = setTimeout(() => { boton.innerHTML = TEXTO_REINICIAR; confirmarReinicio = null; }, 4000);
    return;
  }
  clearTimeout(confirmarReinicio);
  confirmarReinicio = null;
  boton.innerHTML = TEXTO_REINICIAR;
  quitarSismo();
  accion('/api/reiniciar').catch(mostrarError);
  alternarSimulacion(false);
}

async function iniciar() {
  catalogo = await VIGIA.catalogo();
  seleccionar(seleccion);

  document.querySelectorAll('.amenaza').forEach((tab) => {
    tab.addEventListener('click', () => seleccionar(tab.dataset.amenaza, { volar: true, manual: true }));
  });
  // Flechas izquierda/derecha para moverse entre las pestañas de desastres.
  $('tab-deslizamiento').parentElement.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = AMENAZAS.indexOf(seleccion);
    const siguiente = AMENAZAS[(i + (e.key === 'ArrowRight' ? 1 : AMENAZAS.length - 1)) % AMENAZAS.length];
    seleccionar(siguiente, { volar: true, manual: true });
    $(`tab-${siguiente}`).focus();
  });
  $('ver-todo').addEventListener('change', () => { if (estado) filtrarMapa(); });

  $('lateral').addEventListener('click', (e) => {
    const asignar = e.target.closest('.asignar');
    const ir = e.target.closest('[data-ir]');
    const decision = e.target.closest('[data-decision]');
    const restablecer = e.target.closest('[data-restablecer]');
    const liberar = e.target.closest('.liberar');
    const fila = e.target.closest('[data-lat]');
    const tarjeta = e.target.closest('[data-com]');
    if (asignar) {
      accion('/api/asignar', { zona: asignar.dataset.zona, tipo: asignar.dataset.tipo }).catch(mostrarError);
    } else if (decision) {
      accion(`/api/comunidades/${encodeURIComponent(decision.dataset.comId)}/decision`, { decision: decision.dataset.decision }).catch(mostrarError);
    } else if (restablecer) {
      window.restablecerNodo(restablecer.dataset.restablecer);
    } else if (liberar) {
      accion('/api/liberar', { recurso_id: liberar.dataset.recurso }).catch(mostrarError);
    } else if (ir) {
      const z = estado.zonas.find((x) => x.zona === ir.dataset.ir);
      if (z) mapa.flyTo([z.lat, z.lng], 12);
    } else if (fila) {
      mapa.flyTo([Number(fila.dataset.lat), Number(fila.dataset.lng)], 14);
    } else if (tarjeta) {
      const c = (estado.comunidades || []).find((x) => x.id === tarjeta.dataset.com);
      if (c) mapa.flyTo([c.lat, c.lng], 15);
    }
  });
  document.querySelectorAll('[data-escenario]').forEach((boton) => {
    boton.addEventListener('click', () => {
      accion(`/api/simular/${boton.dataset.escenario}`).catch(mostrarError);
      seleccionar(boton.dataset.amenaza, { volar: boton.dataset.amenaza !== 'sismo', manual: true });
      alternarSimulacion(false);
    });
  });
  $('btn-simulacion').addEventListener('click', () => alternarSimulacion());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') alternarSimulacion(false); });
  document.addEventListener('click', (e) => {
    if (!$('simulacion').hidden && !e.target.closest('#simulacion, #btn-simulacion')) alternarSimulacion(false);
  });
  $('modo-demo').addEventListener('change', () => accion('/api/config', { modo_demo: $('modo-demo').checked }).catch(mostrarError));
  $('btn-reiniciar').addEventListener('click', reiniciar);

  setInterval(() => { $('reloj').textContent = VIGIA.hora(VIGIA.ahora()); }, 1000);

  VIGIA.conectar('panel', {
    alMensaje: (msg) => {
      if (msg.tipo !== 'estado') return;
      estado = msg;
      pintar();
    },
    alCambiarConexion: (ok) => {
      $('conexion').textContent = ok ? 'En línea' : 'Reconectando…';
      $('conexion').className = `conexion ${ok ? 'ok' : 'mal'}`;
    },
  });
  requestAnimationFrame(animarSismo);
}

iniciar();
