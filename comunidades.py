"""Comunidades de ladera: tres celulares que se vigilan entre sí.

Cada comunidad tiene dos sensores en la ladera (A en la parte alta y B en la
media) y uno de referencia (R) en suelo estable. El celular nodo, que es este
servidor, decide el estado de la comunidad:

- Normal:   ningún sensor muestra movimiento sostenido.
- Atención: un solo sensor se mueve de forma sostenida, el terreno vibra sin
            parar o un sensor dejó de responder. Se avisa al comité local para
            que verifique en el sitio.
- Alerta:   A y B se mueven a la vez de forma sostenida (coinciden). Se avisa a
            los habitantes según el protocolo con la alcaldía y SINAPRED.

La referencia R compensa: a la inclinación de A y B se le resta la de R (si todo
el sitio se mueve igual, no es la ladera). Si R también vibra, es un sismo y no
un deslizamiento, así que esa vibración no cuenta.

El comité tiene la última palabra en una Atención: puede descartarla (falsa
alarma, por ejemplo una estaca golpeada) o confirmarla (vio grietas en el
sitio), y entonces la comunidad pasa a Alerta aunque B no se haya movido.
"""
from collections import deque

from estado import COMUNIDADES, LUGARES_POR_ID, estado_efectivo

INC_MOVIMIENTO = 0.5  # grados de inclinación, ya compensados con R
VEL_MOVIMIENTO = 0.2  # grados por minuto
VIB_MOVIMIENTO = 0.15  # m/s² de vibración continua del terreno
INC_REFERENCIA_MOVIDA = 1.0  # si R se inclina más que esto, su anclaje está mal
BATERIA_BAJA = 20  # % : por debajo, el comité debe ir a revisar el panel solar o cambiar la batería
SOSTENER_S = 10  # prototipo: segundos. En campo serían minutos, ajustados con las pruebas de ángulo.

NIVELES = ("normal", "atencion", "alerta")
NOMBRE_NIVEL = {"normal": "Normal", "atencion": "Atención", "alerta": "Alerta"}
HISTORIAL_S = 300  # la gráfica de tendencia muestra los últimos 5 minutos


class Comunidades:
    def __init__(self):
        self.reiniciar()

    def reiniciar(self):
        self.config = {c["id"]: c for c in COMUNIDADES}
        self.estado = {
            cid: {"nivel": "normal", "motivos": [], "desde": None, "atendido_por": None, "sensores": {}, "avisos": [],
                  "decision": None, "decision_t": None, "bajar_a": None, "bajar_desde": None, "inmediato": False}
            for cid in self.config
        }
        self._desde = {}  # (nodo, condición) -> desde cuándo se cumple
        self._historial = {}  # nodo -> deque[(t, inclinación)] para la gráfica de tendencia

    def decidir(self, cid, decision, ahora):
        """Decisión del comité tras ir al sitio. Devuelve un texto para la bitácora."""
        st = self.estado.get(cid)
        if st is None:
            raise ValueError("Comunidad desconocida")
        if decision == "falsa":
            if st["nivel"] != "atencion":
                raise ValueError("Solo se puede descartar una Atención")
            st["decision"] = "descartada"
            texto = "el comité revisó y es una falsa alarma"
        elif decision == "confirmar":
            if st["nivel"] != "atencion":
                raise ValueError("Solo se puede confirmar una Atención")
            st["decision"] = "confirmada"
            texto = "el comité confirmó daños en el sitio: pasa a Alerta"
        elif decision == "terminar":
            if st["decision"] != "confirmada":
                raise ValueError("No hay una alerta confirmada por el comité")
            st["decision"] = None
            texto = "el comité dio por terminada la alerta que había confirmado"
        else:
            raise ValueError("Decisión desconocida")
        st["decision_t"] = ahora
        st["inmediato"] = True  # lo que decide el comité se aplica sin esperar
        return texto

    def _anotar_historial(self, nid, ahora, inclinacion):
        h = self._historial.setdefault(nid, deque())
        if not h or ahora - h[-1][0] >= 2000:
            h.append((ahora, round(inclinacion, 2)))
        while h and ahora - h[0][0] > HISTORIAL_S * 1000:
            h.popleft()

    def _esperar_para_bajar(self, st, nivel, motivos, ahora):
        """Subir de nivel es inmediato. Bajar exige que la mejora dure SOSTENER_S seguidos,
        para no cancelar una alerta mientras se reinstalan los sensores uno por uno."""
        if st.pop("inmediato", False) or NIVELES.index(nivel) >= NIVELES.index(st["nivel"]):
            st["bajar_a"] = st["bajar_desde"] = None
            st["inmediato"] = False
            return nivel
        if st["bajar_a"] != nivel:
            st["bajar_a"], st["bajar_desde"] = nivel, ahora
        if ahora - st["bajar_desde"] >= SOSTENER_S * 1000:
            st["bajar_a"] = st["bajar_desde"] = None
            return nivel
        restante = SOSTENER_S - (ahora - st["bajar_desde"]) // 1000
        motivos.insert(0, f"Mejora en observación: baja a {NOMBRE_NIVEL[nivel]} si se mantiene {restante} s más")
        return st["nivel"]

    def _aplicar_decision(self, st, nivel, motivos):
        """El comité manda sobre una Atención, pero nunca apaga una Alerta de los sensores."""
        if st["decision"] == "confirmada":
            motivos.insert(0, "El comité confirmó daños en el sitio")
            return "alerta"
        if st["decision"] == "descartada":
            if nivel == "atencion":
                motivos.insert(0, "Atención descartada por el comité: falsa alarma. Recalibrar el sensor movido")
                return "normal"
            st["decision"] = None  # la situación cambió: vuelve a decidir el nodo
        return nivel

    def _sostenido(self, clave, cumple, ahora):
        if not cumple:
            self._desde.pop(clave, None)
            return False
        desde = self._desde.setdefault(clave, ahora)
        return ahora - desde >= SOSTENER_S * 1000

    def evaluar(self, nodos, ahora):
        """Recalcula todas las comunidades. Devuelve los cambios de nivel:
        [(comunidad_id, nivel_anterior, nivel_nuevo, motivos)]."""
        por_comunidad = {}
        for n in nodos.values():
            if n.get("comunidad") in self.config and n.get("rol"):
                por_comunidad.setdefault(n["comunidad"], {})[n["rol"]] = n
        cambios = []
        for cid in self.config:
            nivel, motivos, sensores = self._decidir(por_comunidad.get(cid, {}), ahora)
            st = self.estado[cid]
            if sensores:
                nivel = self._aplicar_decision(st, nivel, motivos)
            st["sensores"] = sensores
            st["motivos"] = motivos
            nivel = self._esperar_para_bajar(st, nivel, motivos, ahora)
            if nivel != st["nivel"]:
                if NIVELES.index(nivel) > NIVELES.index(st["nivel"]):
                    st["atendido_por"] = None  # empeoró: lo asignado antes ya no alcanza
                cambios.append((cid, st["nivel"], nivel, motivos))
                st["nivel"] = nivel
                st["desde"] = ahora
        return cambios

    def _decidir(self, sensores, ahora):
        if not sensores:
            return "normal", [], {}
        motivos = []
        detalle = {}

        # Batería baja en cualquiera de los tres (si no se está cargando)
        bateria_baja = []
        for rol in ("A", "B", "R"):
            n = sensores.get(rol)
            if n is None or estado_efectivo(n, ahora) == "caido":
                continue
            nivel_bateria = n.get("bateria")
            if isinstance(nivel_bateria, (int, float)) and nivel_bateria < BATERIA_BAJA and not n.get("cargando"):
                bateria_baja.append((rol, int(nivel_bateria)))

        # Referencia
        r = sensores.get("R")
        r_viva = r is not None and estado_efectivo(r, ahora) != "caido"
        inc_r = vib_r = 0.0
        compensar = False
        if r_viva:
            v = r.get("valores") or {}
            inc_r = float(v.get("inclinacion") or 0)
            vib_r = float(v.get("vibracion") or 0)
            compensar = inc_r < INC_REFERENCIA_MOVIDA
            if not compensar:
                motivos.append(f"La referencia R se inclinó {inc_r:.1f}°: revisar su anclaje (no se compensa)")
        elif r is not None:
            motivos.append("La referencia R no responde: no se puede compensar ni descartar sismos")
        else:
            motivos.append("Sin referencia R instalada: no se puede compensar ni descartar sismos")
        r_vibra = r_viva and vib_r >= VIB_MOVIMIENTO
        if r_viva:
            self._anotar_historial(r["id"], ahora, inc_r)
        if r is not None:
            detalle["R"] = {"id": r["id"], "nombre": r["nombre"], "conectado": r_viva,
                            "inclinacion": round(inc_r, 2), "vibracion": round(vib_r, 2), "vibra": r_vibra,
                            "bateria": r.get("bateria")}

        # Sensores de ladera
        movidos, vibrando, caidos = [], [], []
        for rol in ("A", "B"):
            n = sensores.get(rol)
            if n is None:
                motivos.append(f"Falta el sensor {rol}: no se puede confirmar con dos sensores")
                continue
            vivo = estado_efectivo(n, ahora) != "caido"
            v = n.get("valores") or {}
            inc = float(v.get("inclinacion") or 0)
            vel = float(v.get("vel_inclinacion") or 0)
            vib = float(v.get("vibracion") or 0)
            inc_c = max(0.0, inc - inc_r) if compensar else inc
            vib_c = max(0.0, vib - vib_r) if r_viva else vib
            if vivo:
                self._anotar_historial(n["id"], ahora, inc)
            se_mueve = vivo and (inc_c >= INC_MOVIMIENTO or vel >= VEL_MOVIMIENTO)
            vibra = vivo and vib_c >= VIB_MOVIMIENTO and not r_vibra
            mov_sostenido = self._sostenido((n["id"], "mov"), se_mueve, ahora)
            vib_sostenida = self._sostenido((n["id"], "vib"), vibra, ahora)
            detalle[rol] = {
                "id": n["id"], "nombre": n["nombre"], "conectado": vivo,
                "inclinacion": round(inc, 2), "inclinacion_compensada": round(inc_c, 2),
                "velocidad": round(vel, 2), "vibracion": round(vib_c, 2),
                "movimiento": mov_sostenido, "en_observacion": se_mueve and not mov_sostenido,
                "bateria": n.get("bateria"),
            }
            if not vivo:
                caidos.append(rol)
            elif mov_sostenido:
                movidos.append((rol, inc_c, vel))
            if vib_sostenida:
                vibrando.append((rol, vib_c))

        if r_vibra:
            motivos.insert(0, "R también vibra: es un sismo, no un deslizamiento")

        if len(movidos) == 2:
            nivel = "alerta"
            detalle_mov = "; ".join(f"{rol}: {inc:.1f}° ({vel:.1f}°/min)" for rol, inc, vel in movidos)
            motivos.insert(0, f"A y B se mueven a la vez: deslizamiento probable ({detalle_mov})")
        elif movidos or vibrando or caidos or bateria_baja:
            nivel = "atencion"
            for rol, porcentaje in bateria_baja:
                motivos.append(f"El sensor {rol} tiene batería baja ({porcentaje} %): revisar el panel solar")
            for rol, inc, vel in movidos:
                otro = "B" if rol == "A" else "A"
                motivos.insert(0, f"Solo {rol} se mueve ({inc:.1f}°, {vel:.1f}°/min); {otro} no lo confirma: verificar en el sitio")
            for rol, vib in vibrando:
                motivos.insert(0, f"{rol}: vibración continua del terreno ({vib:.2f} m/s²), R quieta")
            for rol in caidos:
                motivos.append(f"El sensor {rol} no responde: revisar energía o señal")
        else:
            nivel = "normal"
        return nivel, motivos, detalle

    def tendencia(self, cid, ahora):
        """Inclinación de A, B y R en los últimos minutos: {rol: [[segundos_atrás, grados], ...]}."""
        resultado = {}
        for rol, s in self.estado[cid]["sensores"].items():
            if not s:
                continue
            puntos = self._historial.get(s["id"], ())
            resultado[rol] = [[round((ahora - t) / 1000), inc] for t, inc in puntos]
        return resultado

    def resumen(self):
        """Estado corto de cada comunidad con sensores, para las apps de la comunidad y de los sensores."""
        return [{"id": cid, "nombre": self.config[cid]["nombre"], "zona": self.config[cid]["zona"],
                 "nivel": st["nivel"], "motivo": st["motivos"][0] if st["motivos"] else "",
                 "decision": st["decision"]}
                for cid, st in self.estado.items() if st["sensores"]]

    def foto(self, ahora=None):
        """Comunidades con al menos un sensor, para el panel."""
        resultado = []
        for cid, st in self.estado.items():
            if not st["sensores"]:
                continue
            c = self.config[cid]
            resultado.append({
                "id": cid, "nombre": c["nombre"], "zona": c["zona"],
                "zona_nombre": LUGARES_POR_ID[c["zona"]]["nombre"],
                "lat": c["lat"], "lng": c["lng"], "personas": c.get("personas", 0),
                "nivel": st["nivel"], "nombre_nivel": NOMBRE_NIVEL[st["nivel"]],
                "motivos": st["motivos"], "desde": st["desde"], "atendido_por": st["atendido_por"],
                "sensores": st["sensores"], "avisos": st["avisos"][-3:],
                "decision": st["decision"], "tendencia": self.tendencia(cid, ahora) if ahora else {},
                "contactos_comite": len(c.get("contactos_comite", [])),
                "contactos_alerta": len(c.get("contactos_alerta", [])),
            })
        orden = {"alerta": 0, "atencion": 1, "normal": 2}
        resultado.sort(key=lambda x: orden[x["nivel"]])
        return resultado
