// VIGÍA · Panel de coordinación (COMUPRED / COE)
// Mapa con nodos, reportes y zonas; ranking de prioridad explicado;
// asignación de recursos; y el avance de las ondas P y S cuando hay un sismo.

const $ = (id) => document.getElementById(id);
const COLOR = { verde: '#22c55e', amarillo: '#facc15', rojo: '#ef4444', caido: '#6b7280' };
const NOMBRE_ESTADO = { verde: 'Normal', amarillo: 'Precaución', rojo: 'ALERTA', caido: 'Sin respuesta' };
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
let sismo = null; // { id, lat, lng, t0, circuloP, circuloS, epicentro }

const mapa = L.map('mapa').setView([12.45, -85.6], 7);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  attribution: '© OpenStreetMap',
}).addTo(mapa);
const capas = {
  zonas: L.layerGroup().addTo(mapa),
  reportes: L.layerGroup().addTo(mapa),
  nodos: L.layerGroup().addTo(mapa),
  sismo: L.layerGroup().addTo(mapa),
};

// ---------- Nodos ----------
function popupNodo(n) {
  const modo = catalogo.modos[n.modo];
  const valores = Object.entries(n.valores || {}).map(([k, v]) => {
    const [nombre, unidad] = ETIQUETAS[k] || [k, ''];
    return `<tr><td>${nombre}</td><td><b>${Number(v).toFixed(2)}</b> ${unidad}</td></tr>`;
  }).join('');
  const hace = Math.round((estado.ahora - n.ultimo_contacto) / 1000);
  return `<div class="popup">
    <b>${modo.emoji} ${VIGIA.esc(n.nombre)}</b>${n.simulado ? ' <small>(simulado)</small>' : ' <small>(celular real)</small>'}<br>
    <span class="etiqueta ${n.estado_efectivo}">${NOMBRE_ESTADO[n.estado_efectivo]}</span>
    ${n.motivo ? `<div>${VIGIA.esc(n.motivo)}</div>` : ''}
    <table>${valores}</table>
    <small>${n.personas} personas · ${n.bateria != null ? `🔋 ${n.bateria}% · ` : ''}último contacto hace ${hace} s</small>
    ${n.atendido_por ? `<div>✔️ Atendido por ${VIGIA.esc(n.atendido_por)}</div>` : ''}
    <button onclick="restablecerNodo('${VIGIA.esc(n.id)}')">Restablecer alarma</button>
  </div>`;
}

function pintarNodos() {
  const vistos = new Set();
  for (const n of estado.nodos) {
    vistos.add(n.id);
    let m = marcadoresNodo.get(n.id);
    if (!m) {
      m = L.circleMarker([n.lat, n.lng], { weight: 3, fillOpacity: 1 }).addTo(capas.nodos);
      m.bindPopup('');
      marcadoresNodo.set(n.id, m);
    }
    m.setLatLng([n.lat, n.lng]);
    m.setStyle({
      radius: n.simulado ? 7 : 11,
      color: n.simulado ? '#ffffff' : '#38bdf8',
      fillColor: COLOR[n.estado_efectivo],
    });
    m.setPopupContent(popupNodo(n));
  }
  for (const [id, m] of marcadoresNodo) {
    if (!vistos.has(id)) { capas.nodos.removeLayer(m); marcadoresNodo.delete(id); }
  }
  const cuenta = { verde: 0, amarillo: 0, rojo: 0, caido: 0 };
  estado.nodos.forEach((n) => { cuenta[n.estado_efectivo]++; });
  const reales = estado.nodos.filter((n) => !n.simulado).length;
  $('resumen-nodos').innerHTML = `📡 ${estado.nodos.length} nodos (${reales} reales) · `
    + `<span style="color:${COLOR.verde}">● ${cuenta.verde}</span> `
    + `<span style="color:${COLOR.amarillo}">● ${cuenta.amarillo}</span> `
    + `<span style="color:${COLOR.rojo}">● ${cuenta.rojo}</span> `
    + `<span style="color:${COLOR.caido}">● ${cuenta.caido} sin respuesta</span>`;
}

window.restablecerNodo = (id) => VIGIA.postJSON(`/api/nodos/${encodeURIComponent(id)}/restablecer`).catch(mostrarError);

// ---------- Reportes ----------
function popupReporte(r) {
  const t = catalogo.tipos_reporte[r.tipo];
  return `<div class="popup">
    <b>${t.emoji} ${VIGIA.esc(t.nombre)}</b><br>
    ${r.personas} persona(s) · ${VIGIA.esc(r.lugar)} · vía ${VIGIA.esc(r.origen)}<br>
    ${r.descripcion ? `<i>${VIGIA.esc(r.descripcion)}</i><br>` : ''}
    <small>${VIGIA.hora(r.creado)}</small>
    ${r.tiene_foto ? `<img src="/api/reportes/${encodeURIComponent(r.id)}/foto" alt="Foto del reporte">` : ''}
    ${r.atendido_por ? `<div>✔️ Atendido por ${VIGIA.esc(r.atendido_por)}</div>` : ''}
  </div>`;
}

function pintarReportes() {
  const vistos = new Set();
  for (const r of estado.reportes) {
    vistos.add(r.id);
    const html = `<span class="icono-reporte ${r.atendido_por ? 'atendido' : ''}">${catalogo.tipos_reporte[r.tipo].emoji}</span>`;
    let m = marcadoresReporte.get(r.id);
    if (!m) {
      m = L.marker([r.lat, r.lng]).addTo(capas.reportes);
      m.bindPopup(popupReporte(r));
      m._html = '';
      marcadoresReporte.set(r.id, m);
    }
    if (m._html !== html) {
      m.setIcon(L.divIcon({ html, className: '', iconSize: [28, 28], iconAnchor: [14, 14] }));
      m.setPopupContent(popupReporte(r));
      m._html = html;
    }
  }
  for (const [id, m] of marcadoresReporte) {
    if (!vistos.has(id)) { capas.reportes.removeLayer(m); marcadoresReporte.delete(id); }
  }
}

// ---------- Zonas y ranking ----------
function colorPrioridad(relativo) {
  if (relativo > 0.66) return COLOR.rojo;
  if (relativo > 0.33) return '#f97316';
  return COLOR.amarillo;
}

function pintarZonas() {
  capas.zonas.clearLayers();
  const maximo = Math.max(1, ...estado.zonas.map((z) => z.puntaje));
  estado.zonas.forEach((z, i) => {
    if (z.puntaje <= 0) return;
    L.circle([z.lat, z.lng], {
      radius: 6000,
      color: colorPrioridad(z.puntaje / maximo),
      weight: 2,
      fillOpacity: 0.15,
    }).bindTooltip(`#${i + 1} ${z.nombre} · ${z.puntaje}`).addTo(capas.zonas);
  });
}

function libres(tipo) {
  return estado.recursos.filter((r) => r.tipo === tipo && !r.zona).length;
}

function pintarRanking() {
  const maximo = Math.max(1, ...estado.zonas.map((z) => z.puntaje));
  $('ranking').innerHTML = estado.zonas.map((z, i) => {
    const sugeridos = Object.entries(z.sugeridos).map(([tipo, n]) => {
      const r = catalogo.recursos[tipo];
      const disponibles = libres(tipo);
      return `<button class="asignar" data-zona="${z.zona}" data-tipo="${tipo}" ${disponibles ? '' : 'disabled'}
        title="${disponibles} libre(s)">${r.emoji} ${VIGIA.esc(r.nombre)} <small>(${n} pedido${n === 1 ? '' : 's'})</small></button>`;
    }).join('');
    const asignados = z.asignados.map((r) =>
      `<span class="asignado">${catalogo.recursos[r.tipo].emoji} ${VIGIA.esc(r.id)}
        <button class="liberar" data-recurso="${VIGIA.esc(r.id)}" title="Marcar como libre">✕</button></span>`).join('');
    return `<li class="zona ${z.puntaje > 0 ? '' : 'atendida'}">
      <div class="zona-cabecera" data-ir="${z.zona}">
        <span class="pos">${i + 1}</span><b>${VIGIA.esc(z.nombre)}</b><span class="puntaje">${z.puntaje}</span>
      </div>
      <div class="barra"><i style="width:${(100 * z.puntaje) / maximo}%;background:${colorPrioridad(z.puntaje / maximo)}"></i></div>
      <ul class="explicacion">${z.explicacion.map((l) => `<li>${VIGIA.esc(l)}</li>`).join('')}</ul>
      ${sugeridos ? `<div class="sugeridos">Enviar: ${sugeridos}</div>` : ''}
      ${asignados ? `<div class="asignados">En camino: ${asignados}</div>` : ''}
    </li>`;
  }).join('') || '<li class="vacio">Sin alertas ni reportes. Todo en calma. ✔️</li>';
}

function pintarRecursos() {
  $('recursos').innerHTML = Object.entries(catalogo.recursos).map(([tipo, r]) =>
    `<span class="recurso ${libres(tipo) ? '' : 'agotado'}" title="${VIGIA.esc(r.nombre)}">${r.emoji} ${libres(tipo)}/${r.total}</span>`).join('');
}

function pintarBitacora() {
  $('bitacora').innerHTML = estado.bitacora.map((b) =>
    `<li class="${b.nivel}"><small>${VIGIA.hora(b.t)}</small> ${VIGIA.esc(b.texto)}</li>`).join('');
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
        icon: L.divIcon({ html: '<span class="epicentro">✳️</span>', className: '', iconSize: [36, 36], iconAnchor: [18, 18] }),
      }).addTo(capas.sismo),
      circuloP: L.circle([ev.lat, ev.lng], { radius: 0, color: '#38bdf8', weight: 2, dashArray: '6 6', fill: false }).addTo(capas.sismo),
      circuloS: L.circle([ev.lat, ev.lng], { radius: 0, color: '#ef4444', weight: 3, fillOpacity: 0.08 }).addTo(capas.sismo),
    };
    mapa.flyTo([ev.lat, ev.lng], 8);
  }
  Object.assign(sismo, { lat: ev.lat, lng: ev.lng, t0: ev.t0, n: ev.n_nodos });
  [sismo.epicentro, sismo.circuloP, sismo.circuloS].forEach((capa) => capa.setLatLng([ev.lat, ev.lng]));
}

function quitarSismo() {
  capas.sismo.clearLayers();
  sismo = null;
  $('banner-sismo').hidden = true;
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
        : `<span class="llegada llego">${VIGIA.esc(l.nombre)} ✔</span>`;
    }).join('');
  $('banner-sismo').hidden = false;
  $('banner-sismo').innerHTML = `<b>🌐 SISMO DETECTADO</b> · confirmado por ${sismo.n} nodo(s) · epicentro estimado
    cerca de ${VIGIA.esc(cercano.nombre)} · hace ${Math.max(0, transcurrido).toFixed(0)} s
    <div class="llegadas">Onda fuerte (S) llega a: ${llegadas}</div>`;
}

// ---------- General ----------
function pintar() {
  pintarNodos();
  pintarReportes();
  pintarZonas();
  pintarRanking();
  pintarRecursos();
  pintarBitacora();
  pintarSismo();
  $('modo-demo').checked = estado.modo_demo;
}

function mostrarError(e) {
  const li = document.createElement('li');
  li.className = 'rojo';
  li.textContent = `⚠️ ${e.message}`;
  $('bitacora').prepend(li);
}

async function iniciar() {
  catalogo = await VIGIA.catalogo();

  $('ranking').addEventListener('click', (e) => {
    const asignar = e.target.closest('.asignar');
    const liberar = e.target.closest('.liberar');
    const ir = e.target.closest('[data-ir]');
    if (asignar) {
      VIGIA.postJSON('/api/asignar', { zona: asignar.dataset.zona, tipo: asignar.dataset.tipo }).catch(mostrarError);
    } else if (liberar) {
      VIGIA.postJSON('/api/liberar', { recurso_id: liberar.dataset.recurso }).catch(mostrarError);
    } else if (ir) {
      const z = estado.zonas.find((x) => x.zona === ir.dataset.ir);
      if (z) mapa.flyTo([z.lat, z.lng], 12);
    }
  });
  document.querySelectorAll('[data-escenario]').forEach((boton) => {
    boton.addEventListener('click', () => VIGIA.postJSON(`/api/simular/${boton.dataset.escenario}`).catch(mostrarError));
  });
  $('modo-demo').addEventListener('change', () => VIGIA.postJSON('/api/config', { modo_demo: $('modo-demo').checked }).catch(mostrarError));
  $('btn-reiniciar').addEventListener('click', () => {
    if (confirm('¿Borrar nodos, reportes y asignaciones y empezar de cero?')) VIGIA.postJSON('/api/reiniciar').catch(mostrarError);
  });

  VIGIA.conectar('panel', {
    alMensaje: (msg) => {
      if (msg.tipo !== 'estado') return;
      estado = msg;
      pintar();
    },
    alCambiarConexion: (ok) => {
      $('conexion').textContent = ok ? '● En línea' : '○ Reconectando…';
      $('conexion').className = `pastilla ${ok ? 'ok' : 'mal'}`;
    },
  });
  requestAnimationFrame(animarSismo);
}

iniciar();
