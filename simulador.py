"""Escenarios simulados para la demo y para probar sin celulares.

Crea nodos virtuales repartidos por Nicaragua y les hace "sentir":
- un sismo: ondas P y S con sus tiempos reales de viaje según la distancia;
- una lluvia intensa: una ladera que se inclina cada vez más rápido y ríos que crecen.
También genera reportes de la comunidad (algunos llegan por SMS).
"""
import asyncio
import math
import random

from estado import LUGARES, LUGARES_POR_ID, ahora_ms, distancia_km, interpretar_sms
from sismo import KM_POR_SEG_SP, VP, VS

# id, nombre, modo, tipo de lugar, personas, zona, desplazamiento (lat, lng)
NODOS_VIRTUALES = [
    ("sim-managua-escuela", "Escuela Managua Centro", "estructura", "escuela", 800, "managua", 0.004, 0.006),
    ("sim-managua-hospital", "Hospital Managua", "estructura", "hospital", 400, "managua", -0.012, -0.010),
    ("sim-sandino-escuela", "Escuela Ciudad Sandino", "estructura", "escuela", 500, "ciudad_sandino", 0, 0),
    ("sim-tipitapa-mercado", "Mercado Tipitapa", "estructura", "edificio", 300, "tipitapa", 0, 0),
    ("sim-masaya-escuela", "Escuela Masaya", "estructura", "escuela", 600, "masaya", 0, 0),
    ("sim-granada-hospital", "Hospital Granada", "estructura", "hospital", 250, "granada", 0, 0),
    ("sim-jinotepe-escuela", "Escuela Jinotepe", "estructura", "escuela", 450, "jinotepe", 0, 0),
    ("sim-masachapa-escuela", "Escuela Masachapa", "estructura", "escuela", 200, "masachapa", 0, 0),
    ("sim-leon-hospital", "Hospital León", "estructura", "hospital", 350, "leon", 0, 0),
    ("sim-chinandega-escuela", "Escuela Chinandega", "estructura", "escuela", 500, "chinandega", 0, 0),
    ("sim-rivas-escuela", "Escuela Rivas", "estructura", "escuela", 400, "rivas", 0, 0),
    ("sim-casita-ladera", "Ladera volcán Casita", "ladera", "ladera", 1500, "posoltega", 0.04, 0.03),
    ("sim-matagalpa-rio", "Río Grande de Matagalpa", "rio", "rio", 2000, "matagalpa", -0.01, 0.01),
    ("sim-waspam-rio", "Río Coco – Waspam", "rio", "rio", 3000, "waspam", 0, 0.01),
]


def posicion(nodo):
    lugar = LUGARES_POR_ID[nodo[5]]
    return lugar["lat"] + nodo[6], lugar["lng"] + nodo[7]


def pga_estimada(magnitud, distancia_hipocentral_km):
    """Aceleración máxima del suelo (m/s²) con una atenuación simplificada.
    Sirve para la demo; no reemplaza un modelo sismológico real."""
    log_g = -1.85 + 0.5 * magnitud - 1.5 * math.log10(distancia_hipocentral_km + 10)
    return 9.81 * 10 ** log_g


class Simulador:
    def __init__(self, procesar_mensaje_nodo, crear_reporte):
        self.procesar = procesar_mensaje_nodo
        self.crear_reporte = crear_reporte
        self.tareas = set()
        self.silenciados = set()  # nodos "destruidos" por el sismo: dejan de reportar
        self.latido = None

    def _lanzar(self, coro):
        tarea = asyncio.create_task(coro)
        self.tareas.add(tarea)
        tarea.add_done_callback(self.tareas.discard)
        return tarea

    def _despues(self, segundos, fabrica):
        """Ejecuta fabrica() (que devuelve una corrutina) dentro de `segundos`."""
        async def esperar():
            await asyncio.sleep(max(0.0, segundos))
            await fabrica()
        self._lanzar(esperar())

    def detener(self):
        for tarea in list(self.tareas):
            tarea.cancel()
        self.tareas.clear()
        self.silenciados.clear()
        self.latido = None

    async def asegurar_nodos(self):
        if self.latido and not self.latido.done():
            return
        for nodo in NODOS_VIRTUALES:
            nid, nombre, modo, tipo, personas, zona, _, _ = nodo
            lat, lng = posicion(nodo)
            await self.procesar({"tipo": "hola", "nodo": {
                "id": nid, "nombre": nombre, "modo": modo, "tipo_lugar": tipo, "personas": personas,
                "lugar": zona, "lat": lat, "lng": lng, "simulado": True,
            }})
        self.latido = self._lanzar(self._latir())

    async def _latir(self):
        while True:
            for nodo in NODOS_VIRTUALES:
                if nodo[0] not in self.silenciados:
                    await self.procesar({"tipo": "latido", "id": nodo[0]})
            await asyncio.sleep(10)

    # ---------- Sismo ----------

    async def sismo(self, lat, lng, magnitud, profundidad_km):
        await self.asegurar_nodos()
        origen = ahora_ms() + 1000  # el sismo "ocurre" dentro de 1 s
        espera = 1.0

        for nodo in NODOS_VIRTUALES:
            nid, modo = nodo[0], nodo[2]
            if modo == "rio":
                continue
            r = math.hypot(distancia_km(lat, lng, *posicion(nodo)), profundidad_km)
            pga = pga_estimada(magnitud, r)
            if pga < 0.15:
                continue  # demasiado débil para el acelerómetro de un celular
            t_p = r / VP + random.uniform(-0.05, 0.05)
            t_s = r / VS
            self._programar_nodo(nid, modo, origen, espera, t_p, t_s, pga)

        for lugar in LUGARES:
            r = math.hypot(distancia_km(lat, lng, lugar["lat"], lugar["lng"]), profundidad_km)
            pga = pga_estimada(magnitud, r)
            if pga < 0.8:
                continue
            for _ in range(min(8, int(pga * 2))):
                demora = espera + r / VS + random.uniform(3, 40)
                self._despues(demora, lambda lugar=lugar, pga=pga: self._reporte_por_sismo(lugar, pga))

    def _programar_nodo(self, nid, modo, origen, espera, t_p, t_s, pga):
        self._despues(espera + t_p, lambda: self.procesar(
            {"tipo": "onda_p", "id": nid, "t": origen + int(t_p * 1000)}))
        self._despues(espera + t_s, lambda: self.procesar(
            {"tipo": "onda_s", "id": nid, "t": origen + int(t_s * 1000),
             "sp": t_s - t_p, "distancia_km": (t_s - t_p) * KM_POR_SEG_SP}))
        self._despues(espera + t_s + 2, lambda: self._resultado_sismo(nid, modo, pga))

    async def _resultado_sismo(self, nid, modo, pga):
        if modo == "estructura" and pga > 2.5 and random.random() < 0.25:
            self.silenciados.add(nid)  # el nodo deja de responder: posible daño grave
            return
        inclinacion = 0.1
        if modo == "estructura" and pga > 2.5 and random.random() < 0.5:
            inclinacion = round(random.uniform(3.2, 6), 1)
        if inclinacion > 3:
            estado, motivo = "rojo", f"Inclinación permanente {inclinacion}°"
        elif pga > 2:
            estado, motivo = "rojo", f"Sacudida fuerte ({pga:.1f} m/s²)"
        elif pga > 0.5:
            estado, motivo = "amarillo", f"Sacudida moderada ({pga:.1f} m/s²)"
        else:
            estado, motivo = "verde", "Todo normal"
        await self.procesar({
            "tipo": "estado", "id": nid, "estado": estado, "motivo": motivo,
            "valores": {"inclinacion": inclinacion, "pga": round(pga, 2)},
            "bateria": random.randint(40, 100),
        })

    async def _reporte_por_sismo(self, lugar, pga):
        if pga > 2:
            tipos, pesos = ["atrapados", "heridos", "edificio", "ruta", "necesidades"], [25, 25, 30, 10, 10]
        else:
            tipos, pesos = ["atrapados", "heridos", "edificio", "ruta", "necesidades"], [3, 20, 40, 10, 27]
        await self._reporte(random.choices(tipos, pesos)[0], lugar)

    # ---------- Lluvia intensa ----------

    async def lluvia(self):
        await self.asegurar_nodos()
        self._lanzar(self._ladera("sim-casita-ladera"))
        self._lanzar(self._rio("sim-matagalpa-rio", subida_cm=220, amarillo=120, rojo=200, retraso=0))
        self._lanzar(self._rio("sim-waspam-rio", subida_cm=320, amarillo=150, rojo=250, retraso=15))
        plan = [
            ("posoltega", "ruta"), ("posoltega", "deslizamiento"), ("posoltega", "atrapados"),
            ("posoltega", "necesidades"), ("matagalpa", "inundacion"), ("matagalpa", "ruta"),
            ("matagalpa", "necesidades"), ("waspam", "inundacion"), ("waspam", "inundacion"),
            ("waspam", "necesidades"), ("bilwi", "inundacion"), ("bilwi", "necesidades"),
            ("leon", "ruta"), ("chinandega", "inundacion"),
        ]
        for zona, tipo in plan:
            self._despues(random.uniform(15, 95), lambda zona=zona, tipo=tipo: self._reporte(tipo, LUGARES_POR_ID[zona]))

    async def _ladera(self, nid):
        anterior = []  # (t, inclinación) para calcular la velocidad
        for paso in range(0, 34):
            t = paso * 3
            inc = 0.1 + 0.015 * t + 0.0012 * max(0, t - 50) ** 2
            anterior.append((t, inc))
            hace = next(((ti, ii) for ti, ii in anterior if t - ti <= 60), (t, inc))
            vel = (inc - hace[1]) / ((t - hace[0]) / 60) if t - hace[0] >= 10 else 0.0
            vibracion = 0.25 if t >= 80 else 0.03
            if t >= 80:
                estado, motivo = "rojo", "Vibración continua del suelo (posible lahar)"
            elif inc > 2 or vel > 1:
                estado, motivo = "rojo", f"Ladera en movimiento: {inc:.1f}° ({vel:.1f}°/min)"
            elif inc > 0.5 or vel > 0.2:
                estado, motivo = "amarillo", f"Ladera inclinándose: {inc:.1f}° ({vel:.1f}°/min)"
            else:
                estado, motivo = "verde", "Todo normal"
            await self.procesar({
                "tipo": "estado", "id": nid, "estado": estado, "motivo": motivo,
                "valores": {"inclinacion": round(inc, 2), "vel_inclinacion": round(vel, 2), "vibracion": vibracion},
                "bateria": 76,
            })
            await asyncio.sleep(3)

    async def _rio(self, nid, subida_cm, amarillo, rojo, retraso):
        await asyncio.sleep(retraso)
        previo = 0.0
        for paso in range(0, 31):
            x = paso / 30
            nivel = subida_cm * x * x * (3 - 2 * x)  # sube suave, se acelera y se estabiliza
            vel = (nivel - previo) / (3 / 60)
            previo = nivel
            if nivel >= rojo:
                estado, motivo = "rojo", f"Crecida: nivel +{nivel:.0f} cm"
            elif nivel >= amarillo:
                estado, motivo = "amarillo", f"Nivel subiendo: +{nivel:.0f} cm"
            else:
                estado, motivo = "verde", "Todo normal"
            await self.procesar({
                "tipo": "estado", "id": nid, "estado": estado, "motivo": motivo,
                "valores": {"nivel_cm": round(nivel), "vel_nivel": round(vel, 1)},
                "bateria": 64,
            })
            await asyncio.sleep(3)

    # ---------- Reportes ----------

    async def reportes(self, cantidad):
        zonas = [LUGARES_POR_ID[z] for z in ("managua", "ciudad_sandino", "tipitapa", "masaya")]
        tipos = ["atrapados", "heridos", "edificio", "ruta", "necesidades"]
        for i in range(cantidad):
            self._despues(i * 0.7, lambda: self._reporte(random.choice(tipos), random.choice(zonas)))

    async def _reporte(self, tipo, lugar):
        if tipo in ("atrapados", "heridos"):
            personas = random.randint(1, 6)
        elif tipo == "necesidades":
            personas = random.randint(5, 60)
        else:
            personas = random.randint(1, 12)
        lat = lugar["lat"] + random.uniform(-0.02, 0.02)
        lng = lugar["lng"] + random.uniform(-0.02, 0.02)
        if random.random() < 0.2:
            # Algunos reportes llegan por SMS, con el mismo formato que usa la app.
            texto = f"VIGIA {tipo.upper()} {personas} {lat:.4f},{lng:.4f}"
            await self.crear_reporte(interpretar_sms(texto), "sms")
            return
        lugar_tipo = random.choices(["casa", "escuela", "hospital", "asilo", "otro"], [70, 10, 5, 5, 10])[0]
        await self.crear_reporte({
            "tipo": tipo, "personas": personas, "lugar": lugar_tipo,
            "lat": lat, "lng": lng, "descripcion": "Reporte simulado",
        }, "simulado")
