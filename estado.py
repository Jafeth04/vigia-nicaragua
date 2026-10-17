"""Estado compartido de VIGÍA: nodos, reportes, recursos y bitácora.

Vive en memoria y se respalda en estado.json para sobrevivir a un
reinicio del servidor.
"""
import json
import math
import re
import time
import unicodedata
from pathlib import Path

ARCHIVO = Path(__file__).parent / "estado.json"

# Zonas de trabajo del prototipo (Nicaragua). Cada reporte y cada nodo se
# asigna a la zona más cercana.
LUGARES = [
    # Norte: comunidades de ladera (núcleo del piloto)
    {"id": "jinotega", "nombre": "Jinotega", "lat": 13.0910, "lng": -86.0023},
    {"id": "somoto", "nombre": "Somoto (Madriz)", "lat": 13.4806, "lng": -86.5836},
    {"id": "ocotal", "nombre": "Ocotal (Nueva Segovia)", "lat": 13.6317, "lng": -86.4756},
    # Ampliación: resto del país
    {"id": "managua", "nombre": "Managua", "lat": 12.1364, "lng": -86.2514},
    {"id": "ciudad_sandino", "nombre": "Ciudad Sandino", "lat": 12.1580, "lng": -86.3440},
    {"id": "tipitapa", "nombre": "Tipitapa", "lat": 12.1975, "lng": -86.0971},
    {"id": "masaya", "nombre": "Masaya", "lat": 11.9744, "lng": -86.0942},
    {"id": "granada", "nombre": "Granada", "lat": 11.9344, "lng": -85.9560},
    {"id": "jinotepe", "nombre": "Jinotepe", "lat": 11.8460, "lng": -86.1990},
    {"id": "masachapa", "nombre": "Masachapa", "lat": 11.7880, "lng": -86.5150},
    {"id": "leon", "nombre": "León", "lat": 12.4379, "lng": -86.8780},
    {"id": "chinandega", "nombre": "Chinandega", "lat": 12.6294, "lng": -87.1311},
    {"id": "posoltega", "nombre": "Posoltega", "lat": 12.5440, "lng": -86.9800},
    {"id": "rivas", "nombre": "Rivas", "lat": 11.4372, "lng": -85.8263},
    {"id": "matagalpa", "nombre": "Matagalpa", "lat": 12.9256, "lng": -85.9175},
    {"id": "esteli", "nombre": "Estelí", "lat": 13.0919, "lng": -86.3538},
    {"id": "bluefields", "nombre": "Bluefields", "lat": 12.0137, "lng": -83.7635},
    {"id": "bilwi", "nombre": "Bilwi", "lat": 14.0300, "lng": -83.3870},
    {"id": "waspam", "nombre": "Waspam", "lat": 14.7390, "lng": -83.9720},
]
LUGARES_POR_ID = {l["id"]: l for l in LUGARES}

# tipo: (emoji, nombre, unidades disponibles)
RECURSOS = {
    "rescate": ("🚒", "Rescate", 3),
    "ambulancia": ("🚑", "Ambulancia", 2),
    "maquinaria": ("🚜", "Maquinaria", 1),
    "evacuacion": ("🚌", "Evacuación", 2),
    "evaluacion": ("🔎", "Inspección en sitio", 2),
    "viveres": ("📦", "Víveres", 3),
}

TIPOS_REPORTE = {
    "atrapados": ("🆘", "Personas atrapadas"),
    "heridos": ("🩹", "Heridos"),
    "edificio": ("🏚️", "Edificio dañado"),
    "inundacion": ("🌊", "Inundación"),
    "deslizamiento": ("⛰️", "Deslizamiento"),
    "ruta": ("🚧", "Ruta bloqueada"),
    "necesidades": ("💧", "Agua / alimentos / refugio"),
}

MODOS = {
    "ladera": ("⛰️", "Sensor de ladera"),
    "referencia": ("📍", "Referencia"),
    "estructura": ("🏫", "Estructura"),
    "rio": ("🌊", "Río"),
}
ROLES = {"A": "Sensor A · ladera alta", "B": "Sensor B · ladera media", "R": "Referencia R · suelo estable"}
TIPOS_LUGAR = {"casa", "escuela", "hospital", "asilo", "edificio", "puente", "ladera", "rio", "otro"}

NODO_CAIDO_MS = 30_000  # sin noticias durante este tiempo = nodo caído


def ahora_ms():
    return int(time.time() * 1000)


def distancia_km(lat1, lng1, lat2, lng2):
    """Distancia sobre la superficie terrestre (fórmula del haversine)."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def lugar_mas_cercano(lat, lng):
    return min(LUGARES, key=lambda l: distancia_km(lat, lng, l["lat"], l["lng"]))


def estado_efectivo(nodo, ahora):
    if ahora - nodo["ultimo_contacto"] > NODO_CAIDO_MS:
        return "caido"
    return nodo["estado"]


# Comunidades de ladera con su trío de sensores (A, B y R). Se editan en comunidades.json,
# incluidos los teléfonos del comité y de los habitantes que reciben los SMS.
COMUNIDADES = json.loads((Path(__file__).parent / "comunidades.json").read_text(encoding="utf-8"))
COMUNIDADES_POR_ID = {c["id"]: c for c in COMUNIDADES}

# Desplazamiento en el mapa de cada rol respecto al centro de su comunidad
_POSICION_ROL = {"A": (0.0040, 0.0030), "B": (0.0020, 0.0015), "R": (-0.0015, -0.0020)}


def catalogo():
    """Listas que comparten el servidor y las apps web."""
    return {
        "lugares": LUGARES,
        "recursos": {k: {"emoji": e, "nombre": n, "total": t} for k, (e, n, t) in RECURSOS.items()},
        "tipos_reporte": {k: {"emoji": e, "nombre": n} for k, (e, n) in TIPOS_REPORTE.items()},
        "modos": {k: {"emoji": e, "nombre": n} for k, (e, n) in MODOS.items()},
        "roles": ROLES,
        "comunidades": [{"id": c["id"], "nombre": c["nombre"], "zona": c["zona"]} for c in COMUNIDADES],
    }


def _sin_tildes(texto):
    return "".join(c for c in unicodedata.normalize("NFD", texto) if unicodedata.category(c) != "Mn").upper()


_CLAVES_SMS = {
    "ATRAP": "atrapados", "HERID": "heridos", "EDIF": "edificio", "INUND": "inundacion",
    "DESLIZ": "deslizamiento", "RUTA": "ruta", "NECES": "necesidades", "AGUA": "necesidades",
}


def interpretar_sms(texto):
    """Convierte un SMS como 'VIGIA ATRAPADOS 3 12.1364,-86.2514' o
    'VIGIA HERIDOS 2 MASAYA' en los datos de un reporte."""
    limpio = _sin_tildes(texto or "")
    tipo = next((t for clave, t in _CLAVES_SMS.items() if clave in limpio), None)
    if not tipo:
        raise ValueError("El SMS no indica qué pasa (ATRAPADOS, HERIDOS, EDIFICIO, ...)")
    datos = {"tipo": tipo, "personas": 1}
    coords = re.search(r"(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)", limpio)
    if coords:
        datos["lat"], datos["lng"] = float(coords.group(1)), float(coords.group(2))
        limpio = limpio.replace(coords.group(0), " ")
    numero = re.search(r"\b(\d{1,4})\b", limpio)
    if numero:
        datos["personas"] = int(numero.group(1))
    if "lat" not in datos:
        for lugar in LUGARES:
            if _sin_tildes(lugar["nombre"]) in limpio or lugar["id"].upper() in limpio:
                datos["zona"] = lugar["id"]
                break
        else:
            raise ValueError("El SMS no indica la ubicación (coordenadas o nombre de la zona)")
    return datos


def crear_recursos():
    return [
        {"id": f"{tipo}-{i}", "tipo": tipo, "zona": None, "desde": None}
        for tipo, (_, _, total) in RECURSOS.items()
        for i in range(1, total + 1)
    ]


class Estado:
    def __init__(self):
        self.reiniciar()
        self.cargar()

    def reiniciar(self):
        self.nodos = {}  # id -> nodo
        self.reportes = {}  # id -> reporte (en orden de llegada)
        self.recursos = crear_recursos()
        self.bitacora = []
        self.modo_demo = False
        self.ultimo_sismo_t = 0
        self.pendiente_guardar = True

    def registrar(self, texto, nivel="info"):
        self.bitacora.append({"t": ahora_ms(), "texto": texto, "nivel": nivel})
        del self.bitacora[:-200]

    def registrar_nodo(self, datos):
        """Alta o actualización de un nodo. Devuelve (nodo, es_nuevo)."""
        nid = str(datos.get("id") or "")[:60]
        if not nid:
            return None, False
        modo = datos.get("modo") if datos.get("modo") in MODOS else "estructura"
        comunidad = datos.get("comunidad") if datos.get("comunidad") in COMUNIDADES_POR_ID and modo in ("ladera", "referencia") else None
        rol = datos.get("rol") if comunidad and datos.get("rol") in ROLES else None
        lat, lng = datos.get("lat"), datos.get("lng")
        if lat is None or lng is None:
            if comunidad:
                c = COMUNIDADES_POR_ID[comunidad]
                dlat, dlng = _POSICION_ROL.get(rol, (0, 0))
                lat, lng = c["lat"] + dlat, c["lng"] + dlng
            else:
                lugar = LUGARES_POR_ID.get(datos.get("lugar"), LUGARES[0])
                lat, lng = lugar["lat"], lugar["lng"]
        previo = self.nodos.get(nid, {})
        nodo = {
            "id": nid,
            "nombre": str(datos.get("nombre") or nid)[:80],
            "modo": modo,
            "comunidad": comunidad,
            "rol": rol,
            "calibraciones": previo.get("calibraciones", []),
            "tipo_lugar": datos.get("tipo_lugar") if datos.get("tipo_lugar") in TIPOS_LUGAR else "otro",
            "personas": max(0, int(datos.get("personas") or 0)),
            "lat": float(lat),
            "lng": float(lng),
            "zona": lugar_mas_cercano(float(lat), float(lng))["id"],
            "estado": previo.get("estado", "verde"),
            "motivo": previo.get("motivo", ""),
            "valores": previo.get("valores", {}),
            "bateria": previo.get("bateria"),
            "ultimo_contacto": ahora_ms(),
            "simulado": bool(datos.get("simulado")),
            "atendido_por": previo.get("atendido_por"),
        }
        self.nodos[nid] = nodo
        return nodo, not previo

    def cargar(self):
        if not ARCHIVO.exists():
            return
        try:
            datos = json.loads(ARCHIVO.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        self.nodos = datos.get("nodos", {})
        self.reportes = datos.get("reportes", {})
        self.recursos = datos.get("recursos") or crear_recursos()
        self.bitacora = datos.get("bitacora", [])
        self.modo_demo = datos.get("modo_demo", False)
        self.ultimo_sismo_t = datos.get("ultimo_sismo_t", 0)

    def guardar(self):
        datos = {
            "nodos": self.nodos, "reportes": self.reportes, "recursos": self.recursos,
            "bitacora": self.bitacora, "modo_demo": self.modo_demo, "ultimo_sismo_t": self.ultimo_sismo_t,
        }
        temporal = ARCHIVO.with_suffix(".tmp")
        temporal.write_text(json.dumps(datos, ensure_ascii=False), encoding="utf-8")
        temporal.replace(ARCHIVO)
        self.pendiente_guardar = False
