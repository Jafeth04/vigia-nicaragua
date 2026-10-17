"""VIGÍA – servidor del celular nodo.

Recibe por WiFi las lecturas de los celulares sensores (A, B y R de cada
comunidad), decide el estado de la comunidad (Normal, Atención o Alerta) y
avisa al comité o a los habitantes según el protocolo. También sirve las apps
web (nodo, comunidad y panel) y, como ampliación, confirma sismos y prioriza.

Puede correr en el celular nodo (Termux), en una computadora de la alcaldía
o en la nube.

Ejecutar (desde la carpeta vigia):
    python -m uvicorn server:app --host 0.0.0.0 --port 8000
"""
import asyncio
import base64
import json
import os
import secrets
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

import notificador
import prioridad
from comunidades import NIVELES, NOMBRE_NIVEL, Comunidades
from estado import (AMENAZA_MODO, AMENAZA_REPORTE, LUGARES_POR_ID, RECURSOS, ROLES, TIPOS_LUGAR, TIPOS_REPORTE, Estado, ahora_ms, catalogo,
                    estado_efectivo, interpretar_sms, lugar_mas_cercano)
from simulador import Simulador
from sismo import VP, VS, Sismos

ESTATICOS = Path(__file__).parent / "static"

# PIN para las acciones del panel (asignar, simular, reiniciar...). Se define con la
# variable de entorno VIGIA_PIN; si no está definida, el panel queda abierto (pruebas locales).
PIN = os.environ.get("VIGIA_PIN", "")


def exigir_pin(x_vigia_pin: str | None = Header(default=None)):
    if PIN and not secrets.compare_digest(x_vigia_pin or "", PIN):
        raise HTTPException(401, "Falta el PIN del panel o es incorrecto")


E = Estado()
S = Sismos()
C = Comunidades()
paneles: set[WebSocket] = set()
comunidad: set[WebSocket] = set()
nodos_conectados: dict[str, WebSocket] = {}
hay_cambios = True


def marcar_cambio():
    global hay_cambios
    hay_cambios = True


# ---------- Difusión ----------

def foto_estado():
    """Todo lo que necesita el panel para dibujarse."""
    ahora = ahora_ms()
    nodos = [{**n, "estado_efectivo": estado_efectivo(n, ahora)} for n in E.nodos.values()]
    reportes = [
        {**{k: v for k, v in r.items() if k != "foto"}, "tiene_foto": bool(r.get("foto"))}
        for r in list(E.reportes.values())[-300:]
    ]
    return {
        "tipo": "estado",
        "ahora": ahora,
        "nodos": nodos,
        "reportes": reportes,
        "zonas": prioridad.calcular(E, ahora, C),
        "comunidades": C.foto(ahora),
        "recursos": E.recursos,
        "bitacora": E.bitacora[-40:][::-1],
        "sismo": S.evento if S.activo(ahora) else None,
        "sismo_real": SIM.sismo_real if SIM.sismo_real and ahora - SIM.sismo_real["t0"] < 150_000 else None,
        "modo_demo": E.modo_demo,
        "vp": VP,
        "vs": VS,
    }


async def enviar_a(sockets, mensaje):
    for ws in list(sockets):
        try:
            await ws.send_json(mensaje)
        except Exception:
            sockets.discard(ws)


async def enviar_a_nodo(nodo_id, mensaje):
    ws = nodos_conectados.get(nodo_id)
    if ws:
        try:
            await ws.send_json(mensaje)
        except Exception:
            nodos_conectados.pop(nodo_id, None)


async def bucle_de_difusion():
    """Envía el estado al panel cuando algo cambia (y cada 3 s igual,
    para que se note cuando un nodo deja de responder)."""
    global hay_cambios
    ultimo_envio = ultimo_guardado = ultima_revision = 0
    while True:
        await asyncio.sleep(0.25)
        ahora = ahora_ms()
        if ahora - ultima_revision >= 1000:  # también detecta sensores que dejaron de responder
            ultima_revision = ahora
            await revisar_comunidades()
        if hay_cambios or ahora - ultimo_envio > 3000:
            if hay_cambios:
                E.pendiente_guardar = True
            hay_cambios = False
            ultimo_envio = ahora
            if paneles:
                await enviar_a(paneles, foto_estado())
        if E.pendiente_guardar and ahora - ultimo_guardado > 2000:
            E.guardar()
            ultimo_guardado = ahora


def protocolo_aviso(nivel):
    """Atención: solo el comité local. Alerta: todos los habitantes de la zona."""
    return "comite" if nivel == "atencion" else "todos"


def contactos(zona=None, comunidad_id=None, publico="comite"):
    """Teléfonos que reciben el SMS: de una comunidad, de las comunidades de una zona o de todas."""
    if comunidad_id:
        lista = [C.config[comunidad_id]]
    else:
        lista = [c for c in C.config.values() if zona is None or c["zona"] == zona]
    numeros = []
    for c in lista:
        numeros += c.get("contactos_comite", [])
        if publico == "todos":
            numeros += c.get("contactos_alerta", [])
    return list(dict.fromkeys(numeros))  # sin repetidos


async def avisar(*, zona, nivel, publico, texto, numeros, comunidad_id=None, ambas_sim=False):
    """Un aviso completo: a la app Comunidad (según el público) y por SMS. Devuelve el resultado del SMS."""
    await enviar_a(comunidad, {
        "tipo": "alerta_zona", "zona": zona, "zona_nombre": LUGARES_POR_ID[zona]["nombre"], "comunidad": comunidad_id,
        "nivel": nivel, "publico": publico, "mensaje": texto, "t": ahora_ms(),
    })
    return await notificador.enviar(numeros, texto, ambas_sim=ambas_sim)


async def revisar_comunidades():
    """El celular nodo decide el estado de cada comunidad y avisa según el protocolo,
    tanto cuando el peligro sube como cuando baja o termina."""
    ahora = ahora_ms()
    cambios = C.evaluar(E.nodos, ahora)
    for cid, antes, nivel, motivos in cambios:
        config = C.config[cid]
        nombre = config["nombre"]
        motivo = motivos[0] if motivos else ""
        marcar_cambio()
        await avisar_sensores_de(cid)
        sube = NIVELES.index(nivel) > NIVELES.index(antes)
        if sube and nivel == "alerta":
            texto = f"VIGIA ALERTA de deslizamiento en {nombre}. {motivo}. Sigue el plan de evacuación de tu comunidad."
            publico, destino = "todos", "comité y habitantes"
        elif sube:
            texto = f"VIGIA ATENCION en {nombre}: {motivo}. Comité: verificar en el sitio."
            publico, destino = "comite", "comité local"
        elif nivel == "atencion":  # bajó de Alerta a Atención: se avisa a todos los que recibieron la Alerta
            texto = f"VIGIA La alerta en {nombre} baja a ATENCION: {motivo}. No regreses hasta que el comité lo indique."
            publico, destino = "todos", "comité y habitantes"
        else:  # vuelve a Normal: avisa a quienes recibieron el último aviso
            regreso = " Regresa solo cuando el comité lo indique." if antes == "alerta" else ""
            texto = f"VIGIA FIN de la {'alerta' if antes == 'alerta' else 'atencion'} en {nombre}: vuelve a Normal.{regreso}"
            publico = protocolo_aviso(antes)
            destino = "comité y habitantes" if publico == "todos" else "comité local"
        E.registrar(f"{nombre}: {NOMBRE_NIVEL[nivel].upper()}. {motivo or 'Sin movimiento en la ladera'}",
                    {"alerta": "rojo", "atencion": "amarillo", "normal": "info"}[nivel],
                    "circle-check" if nivel == "normal" else "triangle-alert", "deslizamiento")
        resultado = await avisar(zona=config["zona"], nivel=nivel, publico=publico, texto=texto, comunidad_id=cid,
                                 numeros=contactos(comunidad_id=cid, publico=publico),
                                 ambas_sim=nivel == "alerta" or antes == "alerta")
        C.estado[cid]["avisos"].append({"t": ahora, "nivel": nivel, "destino": destino, "sms": resultado})
        del C.estado[cid]["avisos"][:-10]
        E.registrar(f"Aviso al {destino} de {nombre}: app enviada; SMS {resultado}", icono="send", amenaza="deslizamiento")
    if cambios:
        await enviar_a(comunidad, {"tipo": "estado_comunidades", "lista": C.resumen()})


async def avisar_sensores_de(cid):
    """Los sensores de la comunidad muestran el estado que decidió el celular nodo."""
    st = C.estado[cid]
    mensaje = {"tipo": "estado_comunidad", "comunidad": cid, "nombre": C.config[cid]["nombre"],
               "nivel": st["nivel"], "motivo": st["motivos"][0] if st["motivos"] else ""}
    for n in E.nodos.values():
        if n.get("comunidad") == cid:
            await enviar_a_nodo(n["id"], mensaje)


def alerta_sismo(evento):
    return {
        "tipo": "alerta_sismo", "id": evento["id"], "lat": evento["lat"], "lng": evento["lng"],
        "t0": evento["t0"], "vp": VP, "vs": VS, "n_nodos": evento["n_nodos"],
    }


# ---------- Mensajes de los nodos ----------

async def procesar_mensaje_nodo(msg):
    tipo = msg.get("tipo")
    if tipo == "hola":
        nodo, nuevo = E.registrar_nodo(msg.get("nodo") or {})
        if not nodo:
            return
        if nuevo:
            donde = (f"{ROLES[nodo['rol']]} de {C.config[nodo['comunidad']]['nombre']}" if nodo.get("comunidad")
                     else LUGARES_POR_ID[nodo["zona"]]["nombre"])
            E.registrar(f"Nodo conectado: {nodo['nombre']} ({donde})", icono="radio-tower", amenaza=AMENAZA_MODO[nodo["modo"]])
        if nodo.get("comunidad"):
            await avisar_sensores_de(nodo["comunidad"])
        marcar_cambio()
        return

    nodo = E.nodos.get(msg.get("id"))
    if not nodo:
        return
    nodo["ultimo_contacto"] = ahora_ms()

    if tipo == "estado":
        await actualizar_estado_nodo(nodo, msg)
        if nodo.get("comunidad"):
            await revisar_comunidades()
    elif tipo == "calibracion":
        registrar_calibracion(nodo, msg)
    elif tipo == "onda_p":
        await registrar_onda_p(nodo, msg)
    elif tipo == "onda_s":
        await registrar_onda_s(nodo, msg)
    elif tipo == "fin_sismo":
        E.registrar(f"{nodo['nombre']}: terminó el movimiento (pico {float(msg.get('pga') or 0):.2f} m/s²)",
                    icono="activity", amenaza="sismo")
    marcar_cambio()


async def actualizar_estado_nodo(nodo, msg):
    nuevo = msg.get("estado") if msg.get("estado") in ("verde", "amarillo", "rojo") else nodo["estado"]
    previo = nodo["estado"]
    nodo.update(
        estado=nuevo,
        motivo=str(msg.get("motivo") or "")[:120],
        valores=msg.get("valores") if isinstance(msg.get("valores"), dict) else {},
        bateria=msg.get("bateria"),
        cargando=msg.get("cargando"),
    )
    if nuevo == previo:
        return
    if nuevo == "verde":
        nodo["atendido_por"] = None
        E.registrar(f"{nodo['nombre']} volvió a la normalidad", icono="circle-check", amenaza=AMENAZA_MODO[nodo["modo"]])
    else:
        if nuevo == "rojo":
            nodo["atendido_por"] = None  # empeoró: lo asignado antes ya no alcanza, vuelve al ranking
        E.registrar(f"{nodo['nombre']}: {nodo['motivo']}", nuevo, "triangle-alert", AMENAZA_MODO[nodo["modo"]])
    if nodo.get("comunidad"):
        return  # en una comunidad decide el celular nodo con A, B y R, no un sensor solo
    await avisar_nodo_suelto(nodo, previo, nuevo)


async def avisar_nodo_suelto(nodo, previo, nuevo):
    """Ampliación: nodos de río, de ladera sin comunidad y de edificios avisan con el mismo protocolo."""
    nivel = {"verde": "normal", "amarillo": "atencion", "rojo": "alerta"}[nuevo]
    antes = {"verde": "normal", "amarillo": "atencion", "rojo": "alerta"}[previo]
    nombre, motivo = nodo["nombre"], nodo["motivo"]
    if nodo["modo"] == "estructura":
        if nivel != "alerta":
            return  # en edificios solo se avisa la alerta; lo demás queda en el panel
        texto = f"VIGIA {nombre}: {motivo}. No entrar al edificio hasta que se revise."
        publico = "comite"
    elif nodo["modo"] in ("ladera", "rio"):
        que = "Peligro de deslizamiento" if nodo["modo"] == "ladera" else "Crecida del río"
        if nivel == "normal":
            texto = f"VIGIA FIN: {nombre} vuelve a la normalidad."
            publico = protocolo_aviso(antes)
        elif nivel == "alerta":
            consejo = "Aléjate de laderas y cauces." if nodo["modo"] == "ladera" else "Prepárate para evacuar."
            texto = f"VIGIA ALERTA. {que}: {nombre}. {motivo}. {consejo}"
            publico = "todos"
        else:
            texto = f"VIGIA ATENCION. {que}: {nombre}. {motivo}. Comité: vigilar."
            publico = "comite"
    else:
        return
    resultado = await avisar(zona=nodo["zona"], nivel=nivel, publico=publico, texto=texto,
                             numeros=contactos(zona=nodo["zona"], publico=publico), ambas_sim=nivel == "alerta")
    E.registrar(f"Aviso de {nombre} ({'todos' if publico == 'todos' else 'comité'}): SMS {resultado}",
                icono="send", amenaza=AMENAZA_MODO[nodo["modo"]])


def registrar_calibracion(nodo, msg):
    """Prueba de ángulo conocido: compara lo que mide el sensor con el ángulo real."""
    try:
        real = float(msg.get("real"))
        medido = float(msg.get("medido"))
    except (TypeError, ValueError):
        return
    nodo["calibraciones"] = (nodo.get("calibraciones", []) + [
        {"t": ahora_ms(), "real": round(real, 2), "medido": round(medido, 2), "error": round(medido - real, 2)}
    ])[-20:]
    E.registrar(f"{nodo['nombre']}: prueba de ángulo real {real:.1f}°, medido {medido:.1f}° (error {medido - real:+.1f}°)",
               icono="ruler", amenaza=AMENAZA_MODO[nodo["modo"]])


async def registrar_onda_p(nodo, msg):
    ahora = ahora_ms()
    t = int(msg.get("t") or ahora)
    if ahora - t > 20_000:
        E.registrar(f"{nodo['nombre']}: detección de onda P llegó tarde, se ignora", icono="clock", amenaza="sismo")
        return
    E.registrar(f"{nodo['nombre']}: onda P detectada", icono="zap", amenaza="sismo")
    resultado = S.onda_p(nodo, t, ahora, 1 if E.modo_demo else 2)
    if not resultado:
        return
    clase, evento = resultado
    await enviar_a(comunidad, alerta_sismo(evento))
    if clase == "nuevo":
        E.ultimo_sismo_t = evento["t0"]
        E.registrar(f"SISMO CONFIRMADO por {evento['n_nodos']} nodo(s). Alerta enviada a la comunidad.", "rojo",
                    "earth", "sismo")
        # El SMS llega en segundos, a menudo después de la sacudida: sirve para que todos los comités sepan y revisen.
        cerca = lugar_mas_cercano(evento["lat"], evento["lng"])["nombre"]
        resultado = await notificador.enviar(
            contactos(publico="comite"), f"VIGIA SISMO detectado cerca de {cerca}. Protégete y luego revisa tu comunidad.",
            ambas_sim=True)
        E.registrar(f"Aviso de sismo a los comités: SMS {resultado}", icono="send", amenaza="sismo")


async def registrar_onda_s(nodo, msg):
    distancia = float(msg.get("distancia_km") or 0)
    E.registrar(f"{nodo['nombre']}: onda S, origen a ~{distancia:.0f} km", icono="activity", amenaza="sismo")
    evento = S.onda_s(nodo["id"], distancia, ahora_ms())
    if evento:
        await enviar_a(comunidad, alerta_sismo(evento))


# ---------- Reportes de la comunidad ----------

async def crear_reporte(datos, origen="app"):
    tipo = datos.get("tipo")
    if tipo not in TIPOS_REPORTE:
        raise ValueError("Tipo de reporte desconocido")
    rid = str(datos.get("id") or uuid.uuid4())[:64]
    if rid in E.reportes:  # reintento de un reporte que ya llegó
        return E.reportes[rid]
    lat, lng = datos.get("lat"), datos.get("lng")
    if lat is None or lng is None:
        lugar = LUGARES_POR_ID.get(datos.get("zona"))
        if not lugar:
            raise ValueError("Falta la ubicación")
        lat, lng = lugar["lat"], lugar["lng"]
    lat, lng = float(lat), float(lng)
    foto = datos.get("foto")
    if not (isinstance(foto, str) and foto.startswith("data:image/") and len(foto) < 800_000):
        foto = None
    ahora = ahora_ms()
    reporte = {
        "id": rid,
        "tipo": tipo,
        "personas": max(1, min(int(datos.get("personas") or 1), 9999)),
        "lugar": datos.get("lugar") if datos.get("lugar") in TIPOS_LUGAR else "casa",
        "descripcion": str(datos.get("descripcion") or "")[:300],
        "foto": foto,
        "lat": lat,
        "lng": lng,
        "zona": lugar_mas_cercano(lat, lng)["id"],
        "origen": origen,
        "creado": int(datos.get("creado") or ahora),
        "recibido": ahora,
        "atendido_por": None,
    }
    E.reportes[rid] = reporte
    icono, nombre = TIPOS_REPORTE[tipo]
    E.registrar(f"{nombre} en {LUGARES_POR_ID[reporte['zona']]['nombre']} "
                f"({reporte['personas']} pers., vía {origen})", icono=icono, amenaza=AMENAZA_REPORTE.get(tipo))
    marcar_cambio()
    return reporte


SIM = Simulador(procesar_mensaje_nodo, crear_reporte)


# ---------- Aplicación ----------

@asynccontextmanager
async def ciclo_de_vida(_app):
    tarea = asyncio.create_task(bucle_de_difusion())
    yield
    tarea.cancel()
    SIM.detener()
    E.guardar()


app = FastAPI(title="VIGÍA", lifespan=ciclo_de_vida)
app.mount("/static", StaticFiles(directory=ESTATICOS), name="static")


@app.get("/")
async def inicio():
    return FileResponse(ESTATICOS / "index.html")


@app.get("/nodo")
async def pagina_nodo():
    return FileResponse(ESTATICOS / "nodo.html")


@app.get("/comunidad")
async def pagina_comunidad():
    return FileResponse(ESTATICOS / "comunidad.html")


@app.get("/panel")
async def pagina_panel():
    return FileResponse(ESTATICOS / "panel.html")


@app.get("/api/catalogo")
async def api_catalogo():
    return catalogo()


@app.get("/api/estado")
async def api_estado():
    return foto_estado()


@app.post("/api/reportes")
async def api_reportes(datos: dict):
    try:
        reporte = await crear_reporte(datos, datos.get("origen") or "app")
    except (ValueError, TypeError) as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "id": reporte["id"], "zona": reporte["zona"]}


@app.get("/api/reportes/{rid}/foto")
async def api_foto(rid: str):
    foto = (E.reportes.get(rid) or {}).get("foto")
    if not foto:
        raise HTTPException(404, "Sin foto")
    cabecera, contenido = foto.split(",", 1)
    return Response(base64.b64decode(contenido), media_type=cabecera[5:].split(";")[0])


@app.post("/api/sms")
async def api_sms(datos: dict):
    """Entrada para una pasarela SMS (por ejemplo, un celular viejo con una app
    que reenvía los SMS recibidos a esta dirección)."""
    try:
        reporte = await crear_reporte(interpretar_sms(datos.get("texto", "")), "sms")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "id": reporte["id"], "zona": reporte["zona"]}


@app.post("/api/nodo/mensaje")
async def api_mensaje_nodo(msg: dict):
    """Misma entrada que el WebSocket, para nodos que solo pueden hacer HTTP."""
    await procesar_mensaje_nodo(msg)
    return {"ok": True}


@app.post("/api/nodos/{nid}/restablecer", dependencies=[Depends(exigir_pin)])
async def api_restablecer_nodo(nid: str):
    nodo = E.nodos.get(nid)
    if not nodo:
        raise HTTPException(404, "Nodo no encontrado")
    nodo.update(estado="verde", motivo="", atendido_por=None)
    E.registrar(f"{nodo['nombre']}: alarma restablecida desde el panel", icono="rotate-ccw",
                amenaza=AMENAZA_MODO[nodo["modo"]])
    await enviar_a_nodo(nid, {"tipo": "restablecer"})
    marcar_cambio()
    return {"ok": True}


@app.post("/api/asignar", dependencies=[Depends(exigir_pin)])
async def api_asignar(datos: dict):
    zona, tipo = datos.get("zona"), datos.get("tipo")
    if zona not in LUGARES_POR_ID or tipo not in RECURSOS:
        raise HTTPException(400, "Zona o recurso inválido")
    recurso = next((r for r in E.recursos if r["tipo"] == tipo and r["zona"] is None), None)
    if not recurso:
        raise HTTPException(409, "No hay unidades libres de ese recurso")
    ahora = ahora_ms()
    recurso.update(zona=zona, desde=ahora)
    cubiertos = prioridad.marcar_atendidos(E, zona, tipo, recurso["id"], ahora, C)
    icono, nombre, _ = RECURSOS[tipo]
    E.registrar(f"{nombre} ({recurso['id']}) asignado a {LUGARES_POR_ID[zona]['nombre']}: "
                f"cubre {cubiertos} pedido(s)", icono=icono)
    marcar_cambio()
    return recurso


@app.post("/api/liberar", dependencies=[Depends(exigir_pin)])
async def api_liberar(datos: dict):
    recurso = next((r for r in E.recursos if r["id"] == datos.get("recurso_id")), None)
    if not recurso or not recurso["zona"]:
        raise HTTPException(404, "Recurso no asignado")
    E.registrar(f"{recurso['id']} quedó libre (volvió de {LUGARES_POR_ID[recurso['zona']]['nombre']})",
                icono=RECURSOS[recurso['tipo']][0])
    recurso.update(zona=None, desde=None)
    marcar_cambio()
    return recurso


@app.post("/api/config", dependencies=[Depends(exigir_pin)])
async def api_config(datos: dict):
    E.modo_demo = bool(datos.get("modo_demo"))
    E.registrar(f"Modo demo {'activado: 1 nodo basta para confirmar un sismo' if E.modo_demo else 'desactivado'}")
    marcar_cambio()
    return {"modo_demo": E.modo_demo}


@app.post("/api/reiniciar", dependencies=[Depends(exigir_pin)])
async def api_reiniciar():
    SIM.detener()
    S.reiniciar()
    C.reiniciar()
    E.reiniciar()
    E.registrar("Sistema reiniciado")
    for nid in list(nodos_conectados):
        await enviar_a_nodo(nid, {"tipo": "reiniciado"})  # los nodos reales vuelven a presentarse
    await enviar_a(comunidad, {"tipo": "estado_comunidades", "lista": C.resumen()})
    marcar_cambio()
    return {"ok": True}


@app.post("/api/comunidades/{cid}/decision", dependencies=[Depends(exigir_pin)])
async def api_decision_comunidad(cid: str, datos: dict):
    """El comité, después de ir al sitio, descarta una Atención, la confirma o termina una alerta confirmada."""
    try:
        texto = C.decidir(cid, datos.get("decision"), ahora_ms())
    except ValueError as e:
        raise HTTPException(400, str(e))
    E.registrar(f"Comité de {C.config[cid]['nombre']}: {texto}", "amarillo", "users", "deslizamiento")
    await revisar_comunidades()
    marcar_cambio()
    return {"ok": True, "nivel": C.estado[cid]["nivel"]}


ESCENARIOS = {
    # Núcleo: comunidad de ladera con A, B y R
    "deslizamiento": SIM.deslizamiento,  # A se mueve, luego B coincide: Atención y después Alerta
    "falsa_alarma": SIM.falsa_alarma,  # solo A se mueve (golpe en la estaca): se queda en Atención
    "sismo_comunidad": SIM.sismo_comunidad,  # A, B y R vibran: R lo identifica como sismo
    # Ampliación
    "sismo_costa": lambda: SIM.sismo(11.75, -86.75, 7.6, 25),  # subducción frente a la costa del Pacífico
    "sismo_managua": lambda: SIM.sismo(12.15, -86.27, 6.2, 5),  # falla local bajo la ciudad
    "lluvia": SIM.lluvia,
    "reportes": lambda: SIM.reportes(12),
    "nodos": SIM.asegurar_nodos,
}


@app.post("/api/simular/{escenario}", dependencies=[Depends(exigir_pin)])
async def api_simular(escenario: str):
    if escenario not in ESCENARIOS:
        raise HTTPException(404, "Escenario desconocido")
    E.registrar(f"Simulación iniciada: {escenario}", icono="play")
    await ESCENARIOS[escenario]()
    marcar_cambio()
    return {"ok": True}


@app.websocket("/ws")
async def websocket(ws: WebSocket, rol: str = "panel", id: str = ""):
    await ws.accept()
    if rol == "nodo":
        nodos_conectados[id] = ws
    elif rol == "comunidad":
        comunidad.add(ws)
    else:
        paneles.add(ws)
    try:
        if ws in paneles:
            await ws.send_json(foto_estado())
        if rol == "comunidad":
            await ws.send_json({"tipo": "estado_comunidades", "lista": C.resumen()})
            if S.activo(ahora_ms()):
                await ws.send_json(alerta_sismo(S.evento))
        while True:
            try:
                msg = json.loads(await ws.receive_text())
            except ValueError:
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("tipo") == "ping":  # sincronización de hora
                await ws.send_json({"tipo": "pong", "t0": msg.get("t0"), "ts": ahora_ms()})
            elif rol == "nodo":
                await procesar_mensaje_nodo(msg)
    except WebSocketDisconnect:
        pass
    finally:
        if rol == "nodo" and nodos_conectados.get(id) is ws:
            del nodos_conectados[id]
        comunidad.discard(ws)
        paneles.discard(ws)
