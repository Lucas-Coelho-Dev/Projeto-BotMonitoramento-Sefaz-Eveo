@echo off
chcp 65001 >nul
title Bot PDV SEFAZ — Rodando

if not exist node_modules (
    echo [ERRO] Dependencias nao instaladas. Execute instalar.bat primeiro.
    pause
    exit /b 1
)
if not exist dist (
    echo [ERRO] Build nao encontrado. Execute instalar.bat primeiro.
    pause
    exit /b 1
)
if not exist .env (
    echo [ERRO] Arquivo .env nao encontrado!
    echo Copie .env.example para .env e preencha DISCORD_TOKEN e CHANNEL_ID.
    pause
    exit /b 1
)

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       Bot PDV SEFAZ — Iniciando...           ║
echo ║   Pressione Ctrl+C para parar                ║
echo ╚══════════════════════════════════════════════╝
echo.

npm start

echo.
echo [INFO] Bot encerrado.
pause