"""Confirmación y localización de sismos a partir de las detecciones de los nodos.

Cada nodo avisa cuando detecta la onda P (y luego la S). El servidor:
1. Confirma el sismo cuando varios nodos detectan la onda P casi a la vez
   (un solo nodo puede ser un portazo o un camión).
2. Estima el epicentro buscando el punto que mejor explica los tiempos de
   llegada de la onda P a cada nodo (búsqueda en grilla).
3. Con el epicentro y la hora de origen, cada celular de la comunidad
   calcula cuántos segundos faltan para que le llegue la onda S.
"""
from estado import distancia_km

VP = 6.0  # velocidad de la onda P (km/s)
VS = 3.5  # velocidad de la onda S (km/s)
KM_POR_SEG_SP = VP * VS / (VP - VS)  # ~8,4 km por cada segundo entre P y S

VENTANA_MS = 15_000  # detecciones de distintos nodos dentro de esta ventana = mismo sismo
DURACION_EVENTO_MS = 120_000


class Sismos:
    def __init__(self):
        self.reiniciar()

    def reiniciar(self):
        self.pendientes = {}  # detecciones aún sin confirmar: nodo_id -> pick
        self.evento = None
        self._contador = 0

    def activo(self, ahora):
        return self.evento is not None and ahora - self.evento["creado"] < DURACION_EVENTO_MS

    def onda_p(self, nodo, t, ahora, min_nodos):
        """Registra una onda P. Devuelve ("nuevo" | "actualizado", evento) o None."""
        pick = {"id": nodo["id"], "lat": nodo["lat"], "lng": nodo["lng"], "tp": t, "dist": None}
        if self.activo(ahora):
            if nodo["id"] in self.evento["nodos"]:
                return None
            self.evento["nodos"][nodo["id"]] = pick
            self._localizar()
            return "actualizado", self.evento

        self.pendientes[nodo["id"]] = pick
        self.pendientes = {k: p for k, p in self.pendientes.items() if t - p["tp"] <= VENTANA_MS}
        if len(self.pendientes) < min_nodos:
            return None
        self._contador += 1
        self.evento = {"id": f"sismo-{self._contador}-{ahora}", "nodos": self.pendientes, "creado": ahora}
        self.pendientes = {}
        self._localizar()
        return "nuevo", self.evento

    def onda_s(self, nodo_id, distancia, ahora):
        """Guarda la distancia estimada con S-P. Devuelve el evento si cambió."""
        if self.activo(ahora) and nodo_id in self.evento["nodos"]:
            self.evento["nodos"][nodo_id]["dist"] = distancia
            self._localizar()
            return self.evento
        if nodo_id in self.pendientes:
            self.pendientes[nodo_id]["dist"] = distancia
        return None

    def _localizar(self):
        picks = list(self.evento["nodos"].values())
        if len(picks) == 1:
            # Con un solo nodo no hay dirección: el epicentro se aproxima al nodo.
            p = picks[0]
            lat, lng = p["lat"], p["lng"]
            t0 = p["tp"] - (p["dist"] or 0) / VP * 1000
        else:
            lat, lng, t0 = buscar_epicentro(picks)
        self.evento.update(lat=round(lat, 4), lng=round(lng, 4), t0=int(t0), n_nodos=len(picks))


def _error(lat, lng, picks):
    """Qué tan mal explica este punto los tiempos observados (menor = mejor)."""
    t0s, extra = [], 0.0
    for p in picks:
        d = distancia_km(lat, lng, p["lat"], p["lng"])
        t0s.append(p["tp"] / 1000 - d / VP)  # hora de origen que implica este nodo
        if p["dist"] is not None:
            extra += 0.5 * ((d - p["dist"]) / VP) ** 2
    media = sum(t0s) / len(t0s)
    return sum((t - media) ** 2 for t in t0s) + extra, media


def buscar_epicentro(picks):
    """Búsqueda en grilla: primero gruesa (~5 km), luego fina (~0,5 km)."""
    lat_c = sum(p["lat"] for p in picks) / len(picks)
    lng_c = sum(p["lng"] for p in picks) / len(picks)
    mejor = (float("inf"), lat_c, lng_c, 0.0)
    for radio, paso in ((1.5, 0.05), (0.1, 0.005)):
        centro_lat, centro_lng = mejor[1], mejor[2]
        pasos = int(round(radio / paso))
        for i in range(-pasos, pasos + 1):
            for j in range(-pasos, pasos + 1):
                lat, lng = centro_lat + i * paso, centro_lng + j * paso
                err, t0 = _error(lat, lng, picks)
                if err < mejor[0]:
                    mejor = (err, lat, lng, t0)
    return mejor[1], mejor[2], mejor[3] * 1000
