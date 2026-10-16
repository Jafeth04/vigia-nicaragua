# Arranca VIGÍA: el servidor (en otra ventana) y el túnel HTTPS para los celulares.
# Uso, desde la carpeta vigia:
#     powershell -ExecutionPolicy Bypass -File iniciar.ps1
# La dirección https://....trycloudflare.com aparece en el recuadro que imprime cloudflared.
# Para apagar todo: cierra esta ventana (túnel) y la ventana del servidor.
param([int]$Puerto = 8080)

Set-Location $PSScriptRoot
Start-Process powershell -ArgumentList '-NoExit', '-Command', "python -m uvicorn server:app --host 0.0.0.0 --port $Puerto"
Start-Sleep -Seconds 3
Write-Host "Panel en la laptop: http://localhost:$Puerto/panel" -ForegroundColor Green

# --edge evita la consulta DNS de tipo SRV que algunas redes WiFi rechazan
# (fue lo que hizo fallar el túnel en la red "equipo 6").
cloudflared tunnel --url "http://localhost:$Puerto" --protocol http2 `
    --edge 198.41.192.7:7844 --edge 198.41.192.27:7844 `
    --edge 198.41.200.13:7844 --edge 198.41.200.23:7844
