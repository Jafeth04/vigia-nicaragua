"""Envío de SMS desde el celular nodo.

Cuando el servidor corre en un celular Android con Termux y la app Termux:API,
usa el comando `termux-sms-send` para mandar SMS con la SIM del propio celular.
En una alerta se envía por las dos SIM (por ejemplo, Claro y Tigo): si una
operadora falla, el mensaje igual llega. Duplicar un aviso de alerta es
preferible a perderlo.

En una computadora (o en Render) no hay SIM: el envío queda solo registrado en
la bitácora como "simulado".
"""
import asyncio
import shutil
import subprocess


def disponible():
    return shutil.which("termux-sms-send") is not None


def _enviar(numero, texto, ranura):
    subprocess.run(["termux-sms-send", "-s", str(ranura), "-n", numero, texto], timeout=30, check=False)


async def enviar(numeros, texto, ambas_sim=False):
    """Devuelve un texto corto para la bitácora."""
    if not numeros:
        return "sin números configurados en comunidades.json"
    if not disponible():
        return f"simulado a {len(numeros)} número(s): este servidor no tiene SIM"
    ranuras = (0, 1) if ambas_sim else (0,)
    for numero in numeros:
        for ranura in ranuras:
            await asyncio.to_thread(_enviar, numero, texto[:300], ranura)
    return f"enviado a {len(numeros)} número(s) por {'las dos SIM' if ambas_sim else 'la SIM 1'}"
