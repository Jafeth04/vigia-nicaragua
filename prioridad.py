"""Priorización de zonas para el panel de coordinación.

    Prioridad de una zona = Σ (gravedad × factor_personas × vulnerabilidad) × confianza

- gravedad: qué tan grave es cada pedido o alerta (tablas de abajo).
- factor_personas: 1 + log2(1 + personas). 50 personas pesan más que 1,
  pero sin aplastar a todo lo demás.
- vulnerabilidad: ×1,5 si afecta una escuela, hospital o asilo.
- confianza: 0,6 con una sola fuente, 0,85 con varias fuentes y 1,0 cuando
  un sensor y la comunidad coinciden.

El sistema recomienda y explica; la decisión la confirma una persona.
"""
import math
from collections import Counter, defaultdict

from estado import LUGARES_POR_ID, TIPOS_REPORTE, estado_efectivo

GRAVEDAD_REPORTE = {
    "atrapados": 10, "deslizamiento": 9, "heridos": 8, "edificio": 6,
    "inundacion": 6, "ruta": 4, "necesidades": 3,
}
RECURSO_REPORTE = {
    "atrapados": "rescate", "deslizamiento": "evacuacion", "heridos": "ambulancia",
    "edificio": "evaluacion", "inundacion": "evacuacion", "ruta": "maquinaria",
    "necesidades": "viveres",
}
GRAVEDAD_SENSOR_ROJO = {"estructura": 7, "ladera": 9, "rio": 7}
GRAVEDAD_SENSOR_AMARILLO = 3
GRAVEDAD_NODO_SILENCIADO = 5  # dejó de responder justo después de un sismo
VULNERABLES = {"escuela", "hospital", "asilo"}


def factor_personas(n):
    return 1 + math.log2(1 + max(0, n))


def recurso_de_nodo(nodo):
    return "evaluacion" if nodo["modo"] == "estructura" else "evacuacion"


def item_de_nodo(nodo, ahora, ultimo_sismo_t):
    if nodo.get("atendido_por") or nodo.get("comunidad"):
        return None  # los sensores de una comunidad cuentan a través de la comunidad
    estado = estado_efectivo(nodo, ahora)
    recurso = recurso_de_nodo(nodo)
    if estado == "rojo":
        gravedad, texto = GRAVEDAD_SENSOR_ROJO[nodo["modo"]], nodo["motivo"]
    elif estado == "amarillo":
        gravedad, texto = GRAVEDAD_SENSOR_AMARILLO, nodo["motivo"]
    elif estado == "caido" and ultimo_sismo_t and nodo["ultimo_contacto"] >= ultimo_sismo_t - 15_000:
        gravedad, texto, recurso = GRAVEDAD_NODO_SILENCIADO, "dejó de responder después del sismo (posible daño grave)", "evaluacion"
    else:
        return None
    return {
        "fuente": "sensor",
        "gravedad": gravedad,
        "personas": nodo.get("personas", 0),
        "vulnerable": nodo.get("tipo_lugar") in VULNERABLES,
        "recurso": recurso,
        "texto": f"{nodo['nombre']}: {texto}",
    }


def item_de_comunidad(cid, st, config):
    """Una comunidad en Atención pide verificar en el sitio; en Alerta, evacuar."""
    if st["nivel"] == "normal" or st.get("atendido_por"):
        return None
    alerta = st["nivel"] == "alerta"
    return {
        "fuente": "sensor",
        "gravedad": 9 if alerta else 3,
        "personas": config.get("personas", 0),
        "vulnerable": False,
        "recurso": "evacuacion" if alerta else "evaluacion",
        "texto": f"{config['nombre']}: {'ALERTA' if alerta else 'Atención'}. {st['motivos'][0] if st['motivos'] else ''}",
    }


def item_de_reporte(reporte):
    if reporte.get("atendido_por"):
        return None
    return {
        "fuente": "reporte",
        "tipo": reporte["tipo"],
        "gravedad": GRAVEDAD_REPORTE[reporte["tipo"]],
        "personas": reporte["personas"],
        "vulnerable": reporte.get("lugar") in VULNERABLES,
        "recurso": RECURSO_REPORTE[reporte["tipo"]],
    }


def _plural(n, singular, plural):
    return f"{n} {singular if n == 1 else plural}"


def explicar(items, confianza):
    lineas = []
    por_tipo = defaultdict(lambda: [0, 0])
    for i in items:
        if i["fuente"] == "reporte":
            por_tipo[i["tipo"]][0] += 1
            por_tipo[i["tipo"]][1] += i["personas"]
    for tipo, (n, personas) in sorted(por_tipo.items(), key=lambda kv: -GRAVEDAD_REPORTE[kv[0]]):
        _, nombre = TIPOS_REPORTE[tipo]
        lineas.append(f"{_plural(n, 'reporte', 'reportes')}: {nombre.lower()} ({_plural(personas, 'persona', 'personas')})")
    lineas += [i["texto"] for i in items if i["fuente"] == "sensor"]
    if any(i["vulnerable"] for i in items):
        lineas.append("Afecta escuela, hospital o asilo (×1,5)")
    if confianza == 1.0:
        lineas.append("Sensor y comunidad coinciden (confianza 100 %)")
    elif confianza == 0.85:
        lineas.append("Varias fuentes (confianza 85 %)")
    else:
        lineas.append("Una sola fuente, conviene verificar (confianza 60 %)")
    return lineas


def calcular(estado, ahora, comunidades=None):
    """Ranking de zonas, de mayor a menor prioridad."""
    items_por_zona = defaultdict(list)
    for nodo in estado.nodos.values():
        item = item_de_nodo(nodo, ahora, estado.ultimo_sismo_t)
        if item:
            items_por_zona[nodo["zona"]].append(item)
    if comunidades:
        for cid, st in comunidades.estado.items():
            config = comunidades.config[cid]
            item = item_de_comunidad(cid, st, config)
            if item:
                items_por_zona[config["zona"]].append(item)
    for reporte in estado.reportes.values():
        item = item_de_reporte(reporte)
        if item:
            items_por_zona[reporte["zona"]].append(item)

    asignados = defaultdict(list)
    for recurso in estado.recursos:
        if recurso["zona"]:
            asignados[recurso["zona"]].append(recurso)

    resultado = []
    for zona_id in set(items_por_zona) | set(asignados):
        items = items_por_zona.get(zona_id, [])
        lugar = LUGARES_POR_ID[zona_id]
        base = sum(
            i["gravedad"] * factor_personas(i["personas"]) * (1.5 if i["vulnerable"] else 1.0)
            for i in items
        )
        hay_sensor = any(i["fuente"] == "sensor" for i in items)
        hay_reporte = any(i["fuente"] == "reporte" for i in items)
        if hay_sensor and hay_reporte:
            confianza = 1.0
        elif len(items) >= 2:
            confianza = 0.85
        else:
            confianza = 0.6
        resultado.append({
            "zona": zona_id,
            "nombre": lugar["nombre"],
            "lat": lugar["lat"],
            "lng": lugar["lng"],
            "puntaje": round(base * confianza, 1),
            "confianza": confianza,
            "pendientes": len(items),
            "explicacion": explicar(items, confianza) if items else ["Pedidos cubiertos, recursos en camino"],
            "sugeridos": dict(Counter(i["recurso"] for i in items)),
            "asignados": asignados.get(zona_id, []),
        })
    resultado.sort(key=lambda z: z["puntaje"], reverse=True)
    return resultado


def marcar_atendidos(estado, zona, tipo_recurso, recurso_id, ahora, comunidades=None):
    """Marca como atendidos los pedidos de la zona que cubre ese tipo de recurso."""
    n = 0
    if comunidades:
        for cid, st in comunidades.estado.items():
            config = comunidades.config[cid]
            item = item_de_comunidad(cid, st, config)
            if config["zona"] == zona and item and item["recurso"] == tipo_recurso:
                st["atendido_por"] = recurso_id
                n += 1
    for reporte in estado.reportes.values():
        if reporte["zona"] == zona and not reporte.get("atendido_por") and RECURSO_REPORTE[reporte["tipo"]] == tipo_recurso:
            reporte["atendido_por"] = recurso_id
            n += 1
    for nodo in estado.nodos.values():
        if nodo["zona"] != zona:
            continue
        item = item_de_nodo(nodo, ahora, estado.ultimo_sismo_t)
        if item and item["recurso"] == tipo_recurso:
            nodo["atendido_por"] = recurso_id
            n += 1
    return n
