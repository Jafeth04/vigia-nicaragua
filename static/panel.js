// VIGÍA · Centro de coordinación (COMUPRED / COE)
// Resumen arriba, mapa con nodos, reportes y zonas; ranking de prioridad
// explicado; recursos; y el avance de las ondas P y S cuando hay un sismo.

const $ = (id) => document.getElementById(id);
const COLOR = { verde: '#2ecc71', amarillo: '#f5b83d', rojo: '#ff4b4b', caido: '#6b7684' };
const NOMBRE_ESTADO = { verde: 'Normal', amarillo: 'Precaución', rojo: 'Alerta', caido: 'Sin respuesta' };
const CLASE_ESTADO = { verde: 'ok', amarillo: 'warn', rojo: 'crit', caido: 'off' };
const REPORTES_GRAVES = new Set(['atrapados', 'heridos', 'deslizamiento']);
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

const mapa = L.map('mapa', { zoomControl: true }).setView([12.45, -85.6], 7);
// Mapa de OpenStreetMap (no pide clave); el CSS lo oscurece para el tema de centro de mando.
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'teselas-oscuras',
  attribution: '© OpenStreetMap',
}).addTo(mapa);
const capas = {
  zonas: L.layerGroup().addTo(mapa),
  reportes: L.layerGroup().addTo(mapa),
  nodos: L.layerGroup().addTo(mapa),
  sismo: L.layerGroup().addTo(mapa),
};

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// ---------- Resumen ----------
function pintarResumen() {
  const cuenta = { verde: 0, amarillo: 0, rojo: 0, caido: 0 };
  estado.nodos.forEach((n) => { cuenta[n.estado_efectivo]++; });
  const total = estado.nodos.length;
  const reales = estado.nodos.filter((n) => !n.simulado).length;
  const enLinea = total - cuenta.caido;
  $('k-nodos').textContent = total ? `${enLinea}/${total}` : '0';
  $('k-nodos-det').textContent = total ? `${plural(reales, 'celular real', 'celulares reales')} · ${total - reales} simulados` : 'Sin nodos conectados';
  $('kpi-nodos').className = 'kpi' + (cuenta.caido ? ' warn' : '');

  $('k-alertas').textContent = cuenta.rojo;
  $('k-alertas-det').textContent = `${cuenta.amarillo} en precaución · ${cuenta.caido} sin respuesta`;
  $('kpi-alertas').className = 'kpi' + (cuenta.rojo ? ' crit' : cuenta.amarillo ? ' warn' : '');

  const pendientes = estado.reportes.filter((r) => !r.atendido_por);
  $('k-pedidos').textContent = pendientes.length;
  $('k-pedidos-det').textContent = `de ${plural(estado.reportes.length, 'reporte recibido', 'reportes recibidos')}`;
  $('kpi-pedidos').className = 'kpi' + (pendientes.some((r) => REPORTES_GRAVES.has(r.tipo)) ? ' crit' : pendientes.length ? ' warn' : '');
  $('k-personas').textContent = pendientes.reduce((s, r) => s + r.personas, 0);

  const libresTot = estado.recursos.filter((r) => !r.zona).length;
  $('k-recursos').textContent = `${libresTot}/${estado.recursos.length}`;
  $('k-recursos-det').textContent = `${plural(estado.recursos.length - libresTot, 'unidad en camino', 'unidades en camino')}`;
  $('kpi-recursos').className = 'kpi' + (libresTot === 0 ? ' crit' : libresTot <= 3 ? ' warn' : ' ok');

  const general = $('estado-general');
  if (estado.sismo) {
    general.className = 'estado-general crit';
    general.textContent = 'Sismo en curso';
  } else if (cuenta.rojo) {
    general.className = 'estado-general crit';
    general.textContent = plural(cuenta.rojo, 'alerta activa', 'alertas activas');
  } else if (cuenta.amarillo || pendientes.length || cuenta.caido) {
    general.className = 'estado-general warn';
    general.textContent = 'Atención';
  } else {
    general.className = 'estado-general ok';
    general.textContent = 'Sin eventos';
  }
}

// ---------- Nodos ----------
function popupNodo(n) {
  const modo = catalogo.modos[n.modo];
  const valores = Object.entries(n.valores || {}).map(([k, v]) => {
    const [nombre, unidad] = ETIQUETAS[k] || [k, ''];
    return `<tr><td>${nombre}</td><td>${Number(v).toFixed(2)} ${unidad}</td></tr>`;
  }).join('');
  const hace = Math.max(0, Math.round((estado.ahora - n.ultimo_contacto) / 1000));
  return `<div class="popup">
    <b>${modo.emoji} ${VIGIA.esc(n.nombre)}</b>
    <span><span class="etq ${CLASE_ESTADO[n.estado_efectivo]}">${NOMBRE_ESTADO[n.estado_efectivo]}</span>
      <small>${n.simulado ? 'Nodo simulado' : 'Celular real'} · ${modo.nombre}</small></span>
    ${n.motivo ? `<span>${VIGIA.esc(n.motivo)}</span>` : ''}
    ${valores ? `<table>${valores}</table>` : ''}
    <small>${n.personas} personas · ${n.bateria != null ? `batería ${n.bateria}% · ` : ''}contacto hace ${hace} s</small>
    ${n.atendido_por ? `<span>✔️ Atendido por ${VIGIA.esc(n.atendido_por)}</span>` : ''}
    <button class="btn btn-pequeno" onclick="restablecerNodo('${VIGIA.esc(n.id)}')">Restablecer alarma</button>
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

window.restablecerNodo = (id) => VIGIA.postJSON(`/api/nodos/${encodeURIComponent(id)}/restablecer`).catch(mostrarError);

// ---------- Reportes ----------
function popupReporte(r) {
  const t = catalogo.tipos_reporte[r.tipo];
  return `<div class="popup">
    <b>${t.emoji} ${VIGIA.esc(t.nombre)}</b>
    <span>${plural(r.personas, 'persona', 'personas')} · ${VIGIA.esc(r.lugar)}</span>
    ${r.descripcion ? `<i>${VIGIA.esc(r.descripcion)}</i>` : ''}
    <small>${VIGIA.hora(r.creado)} · vía ${VIGIA.esc(r.origen)}</small>
    ${r.tiene_foto ? `<img src="/api/reportes/${encodeURIComponent(r.id)}/foto" alt="Foto del reporte">` : ''}
    ${r.atendido_por ? `<span>✔️ Atendido por ${VIGIA.esc(r.atendido_por)}</span>` : ''}
  </div>`;
}

function pintarReportes() {
  const vistos = new Set();
  for (const r of estado.reportes) {
    vistos.add(r.id);
    const clase = `marcador-reporte${REPORTES_GRAVES.has(r.tipo) ? ' grave' : ''}${r.atendido_por ? ' atendido' : ''}`;
    const html = `<span class="${clase}">${catalogo.tipos_reporte[r.tipo].emoji}</span>`;
    let m = marcadoresReporte.get(r.id);
    if (!m) {
      m = L.marker([r.lat, r.lng]).addTo(capas.reportes);
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

// ---------- Zonas y prioridades ----------
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
    const acciones = Object.entries(z.sugeridos).map(([tipo, n]) => {
      const r = catalogo.recursos[tipo];
      const disponibles = libres(tipo);
      return `<button class="btn btn-pequeno ${disponibles ? 'btn-primario' : ''} asignar" data-zona="${z.zona}" data-tipo="${tipo}" ${disponibles ? '' : 'disabled'}>
        Enviar ${r.emoji} ${VIGIA.esc(r.nombre)} <small>· ${disponibles ? plural(n, 'pedido', 'pedidos') : 'sin unidades'}</small></button>`;
    }).join('');
    const enCamino = z.asignados.map((r) => `<span class="etq ok">${catalogo.recursos[r.tipo].emoji} ${VIGIA.esc(r.id)}</span>`).join('');
    return `<li class="zona ${activa && posicion === 1 ? 'primero' : ''} ${activa ? '' : 'atendida'}">
      <div class="zona-cab" data-ir="${z.zona}" title="Ver en el mapa">
        <span class="pos">${activa ? posicion : '✓'}</span>
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
  }).join('') || '<li class="vacio">Sin alertas ni reportes. Todo en calma.</li>';
}

function pintarRecursos() {
  const nombreZona = (id) => (catalogo.lugares.find((l) => l.id === id) || {}).nombre || id;
  $('recursos').innerHTML = Object.entries(catalogo.recursos).map(([tipo, r]) => {
    const unidades = estado.recursos.filter((u) => u.tipo === tipo);
    const usadas = unidades.filter((u) => u.zona);
    const barra = unidades.map((u) => `<i class="${u.zona ? 'usado' : ''}"></i>`).join('');
    const chips = usadas.map((u) => `<span class="unidad">${VIGIA.esc(u.id)} → ${VIGIA.esc(nombreZona(u.zona))}
      <button class="liberar" data-recurso="${VIGIA.esc(u.id)}" title="Marcar como libre: el equipo volvió">Liberar</button></span>`).join('');
    return `<div class="recurso">
      <span>${r.emoji}</span><span>${VIGIA.esc(r.nombre)}</span>
      <span class="recurso-num">${unidades.length - usadas.length}/${unidades.length} libres</span>
      <span class="recurso-barra">${barra}</span>
      ${chips ? `<span class="unidades">${chips}</span>` : ''}
    </div>`;
  }).join('');
  $('recursos-nota').textContent = 'Verde: libre · Ámbar: en camino';
}

function pintarBitacora() {
  $('bitacora').innerHTML = estado.bitacora.map((b) =>
    `<li class="${b.nivel}"><time>${VIGIA.hora(b.t)}</time><span>${VIGIA.esc(b.texto)}</span></li>`).join('');
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
      icon: L.divIcon({ html: '<span class="epicentro-real">✕</span>', className: '', iconSize: [24, 24], iconAnchor: [12, 12] }),
    }).bindTooltip(`Epicentro real (simulación) · M${real.magnitud} · ${real.profundidad_km} km de profundidad`).addTo(capas.sismo);
    sismo.coordReal = real;
  }
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
  $('banner-sismo').hidden = false;
  $('banner-sismo').innerHTML = `
    <div class="sismo-titulo"><b>SISMO DETECTADO</b><span>Epicentro cerca de ${VIGIA.esc(cercano.nombre)} · hace ${Math.max(0, transcurrido).toFixed(0)} s</span></div>
    <div class="sismo-datos">${datos.map((d) => `<span>${d}</span>`).join('')}</div>
    <div class="llegadas">La sacudida fuerte llega a: ${llegadas}</div>`;
}

// ---------- General ----------
function pintar() {
  pintarResumen();
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
  li.innerHTML = `<time>${VIGIA.hora(Date.now())}</time><span></span>`;
  li.lastChild.textContent = `⚠️ ${e.message}`;
  $('bitacora').prepend(li);
}

function alternarSimulacion(abrir) {
  const abierto = abrir ?? $('simulacion').hidden;
  $('simulacion').hidden = !abierto;
  $('btn-simulacion').setAttribute('aria-expanded', String(abierto));
}

let confirmarReinicio = null;
function reiniciar() {
  const boton = $('btn-reiniciar');
  if (!confirmarReinicio) {
    boton.textContent = '¿Seguro? Toca otra vez para borrar todo';
    confirmarReinicio = setTimeout(() => { boton.textContent = 'Reiniciar todo'; confirmarReinicio = null; }, 4000);
    return;
  }
  clearTimeout(confirmarReinicio);
  confirmarReinicio = null;
  boton.textContent = 'Reiniciar todo';
  quitarSismo();
  VIGIA.postJSON('/api/reiniciar').catch(mostrarError);
  alternarSimulacion(false);
}

async function iniciar() {
  catalogo = await VIGIA.catalogo();

  $('ranking').addEventListener('click', (e) => {
    const asignar = e.target.closest('.asignar');
    const ir = e.target.closest('[data-ir]');
    if (asignar) {
      VIGIA.postJSON('/api/asignar', { zona: asignar.dataset.zona, tipo: asignar.dataset.tipo }).catch(mostrarError);
    } else if (ir) {
      const z = estado.zonas.find((x) => x.zona === ir.dataset.ir);
      if (z) mapa.flyTo([z.lat, z.lng], 12);
    }
  });
  $('recursos').addEventListener('click', (e) => {
    const liberar = e.target.closest('.liberar');
    if (liberar) VIGIA.postJSON('/api/liberar', { recurso_id: liberar.dataset.recurso }).catch(mostrarError);
  });
  document.querySelectorAll('[data-escenario]').forEach((boton) => {
    boton.addEventListener('click', () => {
      VIGIA.postJSON(`/api/simular/${boton.dataset.escenario}`).catch(mostrarError);
      alternarSimulacion(false);
    });
  });
  $('btn-simulacion').addEventListener('click', () => alternarSimulacion());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') alternarSimulacion(false); });
  $('modo-demo').addEventListener('change', () => VIGIA.postJSON('/api/config', { modo_demo: $('modo-demo').checked }).catch(mostrarError));
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
