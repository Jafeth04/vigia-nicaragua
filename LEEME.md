# VIGÍA – Prototipo

Celulares en desuso convertidos en estaciones de alerta temprana de
deslizamientos para comunidades de ladera (Desafío 02 – Sensores al servicio
de la comunidad).

En cada comunidad hay tres celulares sensores y un celular nodo:

| Celular | Dónde va | Qué hace |
|---|---|---|
| **A** | Ladera alta, semienterrado y anclado a una estaca | Mide la inclinación y la vibración del terreno |
| **B** | Ladera media, igual que A | Confirma lo que mide A |
| **R** | Suelo estable (casa comunal) | Referencia: compensa a A y B y detecta sismos |
| **Nodo** | Edificio comunitario sobre terreno estable | Recibe a A, B y R por WiFi, decide el estado y avisa por SMS |

El celular nodo decide el estado de la comunidad:

- **Normal:** ningún sensor muestra movimiento sostenido.
- **Atención:** un solo sensor se mueve, el terreno vibra sin parar o un sensor
  no responde. Se avisa **al comité local** para que verifique en el sitio.
- **Alerta:** A y B se mueven a la vez (coinciden). Se avisa **a los habitantes**,
  según el protocolo con la alcaldía y SINAPRED.

Si R también se mueve o vibra, es un sismo o un problema del sitio y no un
deslizamiento: así se evitan falsas alarmas.

Tres apps web servidas por el mismo servidor en Python:

| Dirección | App | Para quién |
|---|---|---|
| `/nodo` | Sensor | El celular en desuso que va como A, B o R |
| `/panel` | Centro de coordinación | Celular nodo, alcaldía o COMUPRED |
| `/comunidad` | Comunidad | Comité local y habitantes: avisos y reportes |

Como **ampliación** (diseño modular), el mismo sistema incluye detección de
sismos con ondas P y S, nivel de ríos, lahares y priorización de recursos
después de un desastre.

## 1. Instalar (una sola vez)

```
cd vigia
python -m pip install -r requirements.txt
```

## 2. Arrancar el servidor

**En una laptop (servidor + túnel HTTPS de una vez):**

```
cd vigia
powershell -ExecutionPolicy Bypass -File iniciar.ps1
```

**Forma manual:**

```
cd vigia
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

En la laptop abre **http://localhost:8000/panel**.

**En la nube:** el proyecto se despliega en Render con `render.yaml`
(https://vigia-nicaragua.onrender.com).

**PIN del panel:** las acciones del panel (asignar recursos, simular, reiniciar,
restablecer nodos, modo demo) piden un PIN si el servidor tiene definida la
variable de entorno `VIGIA_PIN`. En Render: *Environment → Add Environment
Variable → `VIGIA_PIN`*. En una laptop: `$env:VIGIA_PIN = "1234"` antes de
arrancar. Sin la variable, el panel queda abierto. Los reportes de los vecinos
y los sensores nunca piden PIN.

## 3. El celular nodo (Termux) – pendiente de probar en un celular real

El documento del proyecto propone que el celular nodo de la comunidad decida
el estado. El mismo servidor de VIGÍA puede correr en un Android con Termux:

1. Instala **Termux** y **Termux:API** desde F-Droid.
2. En Termux:
   ```
   pkg update
   pkg install python git termux-api
   git clone https://github.com/Jafeth04/vigia-nicaragua
   cd vigia-nicaragua
   pip install -r requirements.txt
   ```
   Si falla compilando `pydantic-core`, instala antes `pkg install rust binutils`.
3. Prueba el permiso de SMS una vez: `termux-sms-send -n <tu número> prueba`.
4. Activa la **zona WiFi** del celular nodo: A, B y R se conectan a ella.
5. Evita que Android lo duerma: `termux-wake-lock`.
6. Arranca: `python -m uvicorn server:app --host 0.0.0.0 --port 8000`.
7. Mira la IP del nodo con `ifconfig` y abre `http://<IP>:8000/nodo` en cada
   sensor (con el flag de Chrome de la sección 4, opción B).

Con `termux-sms-send` disponible, el servidor manda los SMS de verdad: en
Atención al comité, en Alerta al comité y a los habitantes, y en Alerta por las
dos SIM. Sin Termux, el envío queda registrado como «simulado».

## 4. Conectar los celulares (necesitan HTTPS o el flag de Chrome)

Los navegadores solo entregan el acelerómetro y el GPS en páginas **HTTPS**.

**Opción A – Túnel o Render (con internet).** Abre la dirección `https://`.

**Opción B – Red local sin internet (zona WiFi del nodo o router).**

1. Anota la IP del servidor (`ipconfig` en Windows, `ifconfig` en Termux).
2. En cada celular sensor, Chrome → `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
   → agrega `http://<IP>:8000` → *Enabled* → reiniciar Chrome.
3. Abre `http://<IP>:8000/nodo`.

## 5. Configurar una comunidad

Las comunidades están en `comunidades.json`: nombre, zona, ubicación,
personas y los teléfonos que reciben SMS:

- `contactos_comite`: reciben Atención y Alerta.
- `contactos_alerta`: habitantes que reciben solo Alerta.

Para la maqueta se usa la **«Comunidad de prueba (maqueta)»**.

En cada celular sensor (`/nodo`):

1. Elige **Sensor de ladera (A o B)** o **Referencia (R)**.
2. Elige la comunidad y, si es sensor de ladera, la posición A o B.
3. **Calibrar e iniciar** con el celular quieto en su posición final.

## 6. Probar sin celulares

El panel está separado por desastre natural. Las cuatro tarjetas de arriba
(**Deslizamientos**, **Sismos**, **Inundaciones** y **Población y recursos**) muestran
el estado de cada uno; al tocar una, el mapa y la columna derecha muestran solo
lo de ese desastre. Si uno pasa a Alerta, el panel lo abre solo.

En el panel, menú **Simulación** (también agrupado por desastre):

- **Deslizamiento:** A empieza a moverse (Atención a los ~16 s, aviso al comité)
  y B lo confirma (Alerta a los ~34 s, aviso a todos).
- **Falsa alarma:** solo se mueve A (un golpe en la estaca). Se queda en Atención.
- **Sismo:** A, B y R vibran. R lo identifica como sismo: no hay alerta de deslizamiento.
- Ampliación: sismos en la costa y en Managua, lluvia con lahar y ríos, reportes.
- **Reiniciar todo** deja el sistema limpio antes de presentar.

## 7. Guion de la demo (3 minutos)

1. Panel en calma. **Reiniciar todo**.
2. Maqueta de ladera: bandeja con tierra húmeda en pendiente. Celulares A y B
   en bolsas con cierre, pegados a paletas clavadas en la tierra. R sobre la
   mesa (suelo estable). Los tres en «Comunidad de prueba» y calibrados.
3. Celular del comité en `/comunidad`, zona *Jinotega*, con «Soy del comité»
   marcado y **Activar alertas**.
4. Echa agua en la parte alta: la paleta de A se inclina → **Atención** →
   suena el aviso solo en el celular del comité.
5. Sigue echando agua hasta que ceda la zona de B → **Alerta** → aviso a todos.
6. Golpea solo la estaca de A en otra prueba: se queda en Atención (sin falsa alarma).
7. Cierra con «Simulación → Deslizamiento» para mostrar el panel completo.

## 8. Dónde ajustar cosas

| Qué | Dónde |
|---|---|
| Umbrales de la comunidad (0,5°, 0,2°/min, tiempo sostenido) | `comunidades.py` |
| Umbrales del celular sensor | `static/nodo.js` → `UMBRALES` |
| Comunidades y teléfonos para SMS | `comunidades.json` |
| Envío de SMS por las dos SIM | `notificador.py` |
| Gravedad, vulnerabilidad y confianza (ampliación) | `prioridad.py` |
| Escenarios de prueba | `simulador.py` |
| A qué desastre pertenece cada sensor y reporte | `estado.py` → `AMENAZA_MODO`, `AMENAZA_REPORTE` |
| Íconos (Lucide, sin internet) | `static/iconos.js` |

Los umbrales se definen con la **prueba de ángulos conocidos** de la app del
sensor: se apoya el celular en cuñas de 5°, 10° y 15° y se registra lo que mide.

## 9. Limitaciones (decirlas con honestidad)

- `SOSTENER_S` vale 10 s para poder demostrarlo; en campo serían minutos,
  definidos con las pruebas.
- Es una página web: el sensor debe quedar con la pantalla abierta. La versión
  de campo sería una app Android que mide con la pantalla apagada.
- El celular nodo con Termux está descrito pero no probado en un celular real.
- La sensibilidad de un celular es limitada: por eso se exige movimiento
  sostenido y coincidencia entre A y B, con R como referencia.
- El mapa necesita internet para las imágenes de fondo (OpenStreetMap).
