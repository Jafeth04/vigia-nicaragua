"""Confirmación y localización de sismos a partir de las detecciones de los nodos.

Cada nodo avisa cuando detecta la onda P (y luego la S). El servidor:
1. Confirma el sismo cuando varios nodos detectan la onda P casi a la vez
   (un solo nodo puede ser un portazo o un camión).
2. Estima el epicentro buscando el punto (y la profundidad) que mejor explica
   los tiempos de llegada de la onda P a cada nodo y las distancias S-P.
3. Calcula la incertidumbre: el radio de la zona donde el epicentro podría estar.
4. Con el epicentro y la hora de origen, cada celular de la comunidad
   calcula cuántos segundos faltan para que le llegue la onda S.
"""
import math

VP = 6.0  # velocidad de la onda P (km/s)
VS = 3.5  # velocidad de la onda S (km/s)
KM_POR_SEG_SP = VP * VS / (VP - VS)  # ~8,4 km por cada segundo entre P y S

VENTANA_MS = 15_000  # detecciones de distintos nodos dentro de esta ventana = mismo sismo
DURACION_EVENTO_MS = 120_000

PROFUNDIDAD_SUPUESTA_KM = 15  # cuando hay pocos nodos para calcularla
PROFUNDIDADES_KM = (5, 10, 20, 30, 45)  # se prueban con 4 nodos o más
SIGMA_S = 0.15  # imprecisión típica de cada detección (segundos)


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
            # Con un solo nodo no hay dirección: solo se sabe que el origen está
            # a `dist` km del nodo (si ya llegó la onda S).
            p = picks[0]
            dist = p["dist"] or 0
            resultado = {"lat": p["lat"], "lng": p["lng"], "t0": p["tp"] - dist / VP * 1000,
                         "profundidad_km": None, "incertidumbre_km": dist or None}
        else:
            resultado = buscar_epicentro(picks)
        self.evento.update(
            lat=round(resultado["lat"], 4), lng=round(resultado["lng"], 4), t0=int(resultado["t0"]),
            profundidad_km=resultado["profundidad_km"],
            incertidumbre_km=None if resultado["incertidumbre_km"] is None else round(resultado["incertidumbre_km"], 1),
            n_nodos=len(picks),
        )


class _Modelo:
    """Tiempos de llegada esperados para un epicentro de prueba.
    Usa distancias en un plano local (precisas a escala de un país y mucho más rápidas)."""

    def __init__(self, picks):
        self.lat0 = sum(p["lat"] for p in picks) / len(picks)
        self.ky = 110.57
        self.kx = 111.32 * math.cos(math.radians(self.lat0))
        self.t_ref = min(p["tp"] for p in picks) / 1000
        self.obs = [(p["lat"], p["lng"], p["tp"] / 1000 - self.t_ref, p["dist"]) for p in picks]
        primero = min(picks, key=lambda p: p["tp"])
        self.primero = (primero["lat"], primero["lng"])
        # Con solo 2 nodos hay infinitas soluciones: se prefiere la más cercana
        # al primer nodo que sintió el sismo (el epicentro está más cerca de él).
        self.peso_cercania = 0.01 if len(picks) == 2 else 0.0

    def error(self, lat, lng, prof):
        t0s = []
        extra = 0.0
        for plat, plng, tp, dist in self.obs:
            dx = (plng - lng) * self.kx
            dy = (plat - lat) * self.ky
            r = math.sqrt(dx * dx + dy * dy + prof * prof)  # distancia al hipocentro
            t0s.append(tp - r / VP)  # hora de origen que implica este nodo
            if dist is not None:
                extra += 0.5 * ((r - dist) / VP) ** 2  # S-P también mide la distancia al hipocentro
        media = sum(t0s) / len(t0s)
        err = sum((t - media) ** 2 for t in t0s) + extra
        if self.peso_cercania:
            dx = (self.primero[1] - lng) * self.kx
            dy = (self.primero[0] - lat) * self.ky
            err += self.peso_cercania * (dx * dx + dy * dy) / VP ** 2
        return err, media

    def km(self, lat1, lng1, lat2, lng2):
        return math.hypot((lng2 - lng1) * self.kx, (lat2 - lat1) * self.ky)


def buscar_epicentro(picks):
    """Búsqueda en grilla: primero gruesa (~5 km), luego fina (~0,5 km) probando profundidades."""
    modelo = _Modelo(picks)
    lat_c = sum(p["lat"] for p in picks) / len(picks)
    lng_c = sum(p["lng"] for p in picks) / len(picks)

    gruesa = []
    paso, pasos = 0.05, 24  # ±1,2° alrededor de los nodos
    for i in range(-pasos, pasos + 1):
        for j in range(-pasos, pasos + 1):
            lat, lng = lat_c + i * paso, lng_c + j * paso
            gruesa.append((modelo.error(lat, lng, PROFUNDIDAD_SUPUESTA_KM)[0], lat, lng))
    err_g, lat_g, lng_g = min(gruesa)

    profundidades = PROFUNDIDADES_KM if len(picks) >= 4 else (PROFUNDIDAD_SUPUESTA_KM,)
    mejor = (float("inf"), lat_g, lng_g, PROFUNDIDAD_SUPUESTA_KM, 0.0)
    paso, pasos = 0.005, 16  # ±0,08° alrededor del mejor punto grueso
    for prof in profundidades:
        for i in range(-pasos, pasos + 1):
            for j in range(-pasos, pasos + 1):
                lat, lng = lat_g + i * paso, lng_g + j * paso
                err, t0 = modelo.error(lat, lng, prof)
                if err < mejor[0]:
                    mejor = (err, lat, lng, prof, t0)
    _, lat, lng, prof, t0 = mejor

    # Incertidumbre: hasta dónde llegan los puntos que explican los datos casi igual de bien.
    umbral = err_g + len(picks) * SIGMA_S ** 2
    radio = max((modelo.km(lat, lng, la, ln) for e, la, ln in gruesa if e <= umbral), default=0.0)
    return {
        "lat": lat, "lng": lng, "t0": (t0 + modelo.t_ref) * 1000,
        "profundidad_km": prof if len(picks) >= 4 else None,
        "incertidumbre_km": max(radio, 3.0),
    }
