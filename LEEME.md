# VIGÍA – Prototipo

Celulares en desuso que vigilan estructuras, laderas y ríos, y un panel que
ayuda a COMUPRED a decidir a quién atender primero después de un desastre.

Tres apps web servidas por un solo servidor en Python:

| Dirección | App | Para quién |
|---|---|---|
| `/nodo` | Nodo sensor | El celular viejo fijo en la estructura, la ladera o el río |
| `/comunidad` | Comunidad | Vecinos y brigadistas: reportan y reciben alertas |
| `/panel` | Panel de coordinación | COMUPRED / COE: mapa, prioridades y recursos |

## 1. Instalar (una sola vez)

```
cd vigia
python -m pip install -r requirements.txt
```

## 2. Arrancar el servidor

**Forma rápida (servidor + túnel HTTPS de una vez):**

```
cd vigia
powershell -ExecutionPolicy Bypass -File iniciar.ps1
```

Usa el puerto 8080 (en esta laptop el 8000 lo ocupa otro programa). Si se va
internet, el túnel se reconecta solo y conserva la dirección mientras la
ventana siga abierta. Si cierras la ventana, la dirección cambia.

**Forma manual:**

```
cd vigia
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

En la laptop abre **http://localhost:8000/panel**.

## 3. Conectar los celulares (necesitan HTTPS)

Los navegadores solo entregan el acelerómetro y el GPS en páginas **HTTPS**.

**Opción A – Túnel gratuito (con internet).** Recomendada para el rally.

```
winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:8000
```

Aparece una dirección como `https://algo-al-azar.trycloudflare.com`. Ábrela en
cada celular (`/nodo` en el celular sensor, `/comunidad` en el del vecino).
La dirección cambia cada vez que se reinicia el túnel.

**Opción B – Sin internet (misma red WiFi).**

1. En la laptop, `ipconfig` → anota la IPv4 (ej. `192.168.1.20`).
2. En el celular, Chrome → `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
   → agrega `http://192.168.1.20:8000` → *Enabled* → reiniciar Chrome.
3. Abre `http://192.168.1.20:8000/nodo`.

Si Windows pregunta por el firewall al arrancar el servidor, permite el acceso en redes privadas.

## 4. Probar sin celulares

En el panel, abajo:

- **Sismo costa Pacífico (M7.6)**: los nodos virtuales detectan las ondas P y S,
  se confirma el sismo, se estima el epicentro y llegan reportes.
  Managua recibe ~10 s de aviso.
- **Sismo falla de Managua (M6.2)**: el contraste. Casi no hay tiempo de aviso.
- **Lluvia intensa**: la ladera del Casita se inclina cada vez más rápido
  (y luego vibra: posible lahar) y crecen los ríos de Matagalpa y Waspam.
- **Reportes de prueba**: 12 reportes en Managua y alrededores.
- **Modo demo**: con un solo nodo basta para confirmar un sismo (la maqueta).
- **Reiniciar todo**: deja el sistema limpio antes de presentar.

## 5. Guion de la demo (3 minutos)

1. Panel en calma. Presiona **Reiniciar todo** y activa **Modo demo**.
2. Celular-nodo pegado a la maqueta, modo *Estructura*, zona *Masachapa*:
   **Calibrar e iniciar** y espera 10 s sin tocarlo.
3. Celular del vecino en `/comunidad`, zona *Managua*, toca **Activar alertas con sonido**.
4. Golpecitos verticales a la maqueta (onda P) → sacudida lateral fuerte (onda S).
   El vecino recibe la alerta con cuenta regresiva y el nodo se pone rojo en el panel.
5. Inclina la maqueta y déjala así 5 s: "Inclinación permanente".
6. El vecino pone **modo avión**, reporta "Personas atrapadas" → queda en cola →
   quita el modo avión → llega solo.
7. En el panel, Masachapa sube al #1 con su explicación → **Enviar 🚒 Rescate**.
8. **Sismo costa Pacífico** para mostrar la escala: ondas P/S en el mapa y ranking automático.

## 6. Dónde ajustar cosas

| Qué | Dónde |
|---|---|
| Umbrales del celular (inclinación, sacudida, STA/LTA, ladera) | `static/nodo.js` → `UMBRALES` |
| Gravedad de cada tipo de pedido, vulnerabilidad, confianza | `prioridad.py` |
| Velocidades de las ondas, ventana de confirmación | `sismo.py` |
| Zonas (ciudades) y recursos disponibles | `estado.py` → `LUGARES`, `RECURSOS` |
| Nodos virtuales y escenarios | `simulador.py` |

El estado se guarda en `estado.json` (se crea solo). Bórralo o usa
**Reiniciar todo** para empezar de cero.

## 7. Cómo funciona por dentro

- **Nodo** (`nodo.js`): calibra la gravedad 5 s, separa el movimiento en vertical
  y horizontal. La onda P se detecta con **STA/LTA** sobre el componente vertical
  (promedio de 0,5 s más de 4 veces el de 10 s). La onda S es el pico horizontal
  posterior. Segundos entre P y S × 8,4 = km al origen. La inclinación es el ángulo
  entre la gravedad actual y la calibrada. En modo río, el ángulo del brazo con
  flotador se convierte en nivel de agua.
- **Servidor** (`server.py` + `sismo.py`): confirma el sismo cuando 2 nodos detectan
  la onda P en menos de 15 s, estima el epicentro con una búsqueda en grilla sobre
  los tiempos de llegada y envía la alerta. Cada celular calcula cuánto le falta
  a la onda S según su distancia.
- **Prioridad** (`prioridad.py`):
  `Σ (gravedad × (1 + log2(1 + personas)) × vulnerabilidad) × confianza`.
- **Comunidad** (`comunidad.js`): los reportes se guardan en el celular y se
  reintentan cada 5 s. El servidor ignora duplicados, así que reintentar es seguro.

## 8. Limitaciones (decirlas con honestidad)

- Es una página web: el nodo debe quedar con la pantalla abierta (se mantiene
  encendida sola). La versión final sería una app Android con servicio en segundo plano.
- El acelerómetro de un celular detecta sismos moderados o fuertes, no microsismos.
- Cerca del epicentro no hay tiempo de aviso. La alerta temprana sirve para sismos lejanos.
- La red de celular a celular sin internet (WiFi Direct o Bluetooth) no está en el
  prototipo: se muestra la cola sin conexión y el respaldo por SMS.
- El mapa necesita internet para las imágenes de fondo (OpenStreetMap).
