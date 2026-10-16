// Utilidades compartidas por las tres apps: conexión en tiempo real con
// reconexión automática, hora sincronizada con el servidor y catálogo.
const VIGIA = (() => {
  let desfase = 0; // hora del servidor - hora local (ms)
  let catalogoCache = null;

  const ahora = () => Date.now() + desfase;

  function conectar(rol, { id = '', alMensaje = () => {}, alCambiarConexion = () => {} } = {}) {
    const cola = []; // mensajes que esperan conexión
    let ws = null;
    let abierto = false;
    let espera = 1000;
    const protocolo = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${protocolo}://${location.host}/ws?rol=${rol}&id=${encodeURIComponent(id)}`;

    function sincronizarHora() {
      if (abierto) ws.send(JSON.stringify({ tipo: 'ping', t0: Date.now() }));
    }

    function abrir() {
      ws = new WebSocket(url);
      ws.onopen = () => {
        abierto = true;
        espera = 1000;
        alCambiarConexion(true); // aquí el nodo se presenta antes de vaciar la cola
        sincronizarHora();
        while (cola.length && abierto) ws.send(cola.shift());
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.tipo === 'pong') {
          desfase = msg.ts - (msg.t0 + Date.now()) / 2;
          return;
        }
        alMensaje(msg);
      };
      ws.onclose = () => {
        const estaba = abierto;
        abierto = false;
        if (estaba) alCambiarConexion(false);
        setTimeout(abrir, espera);
        espera = Math.min(espera * 2, 15000);
      };
      ws.onerror = () => ws.close();
    }

    setInterval(sincronizarHora, 30000);
    abrir();

    return {
      enviar(msg, { encolar = true } = {}) {
        const texto = JSON.stringify(msg);
        if (abierto) ws.send(texto);
        else if (encolar) {
          cola.push(texto);
          if (cola.length > 500) cola.shift();
        }
      },
      get conectado() { return abierto; },
      get pendientes() { return cola.length; },
    };
  }

  async function catalogo() {
    if (!catalogoCache) catalogoCache = await (await fetch('/api/catalogo')).json();
    return catalogoCache;
  }

  async function postJSON(url, datos = {}) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos),
    });
    if (!resp.ok) {
      let detalle = resp.statusText;
      try { detalle = (await resp.json()).detail || detalle; } catch (e) { /* sin cuerpo */ }
      const error = new Error(detalle);
      error.status = resp.status;
      throw error;
    }
    return resp.json();
  }

  function distanciaKm(lat1, lng1, lat2, lng2) {
    const rad = (g) => (g * Math.PI) / 180;
    const dp = rad(lat2 - lat1);
    const dl = rad(lng2 - lng1);
    const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  }

  function lugarMasCercano(lugares, lat, lng) {
    let mejor = lugares[0];
    for (const l of lugares) {
      if (distanciaKm(lat, lng, l.lat, l.lng) < distanciaKm(lat, lng, mejor.lat, mejor.lng)) mejor = l;
    }
    return mejor;
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function hora(ms) {
    return new Date(ms).toLocaleTimeString('es-NI', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function esc(texto) {
    return String(texto ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function leer(clave, porDefecto) {
    try { return JSON.parse(localStorage.getItem(clave)) ?? porDefecto; } catch (e) { return porDefecto; }
  }

  function guardar(clave, valor) {
    try { localStorage.setItem(clave, JSON.stringify(valor)); } catch (e) { /* almacenamiento lleno o bloqueado */ }
  }

  return { ahora, conectar, catalogo, postJSON, distanciaKm, lugarMasCercano, uid, hora, esc, leer, guardar };
})();
