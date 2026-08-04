@echo off
chcp 65001 >nul
title Bot PDV SEFAZ — Instalador (Node.js)

echo.
echo ╔══════════════════════════════════════════════╗
echo ║    Bot PDV SEFAZ — Instalador Node.js        ║
echo ╚══════════════════════════════════════════════╝
echo.

:: Verifica Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] Node.js nao encontrado!
    echo.
    echo Instale o Node.js LTS em: https://nodejs.org
    echo Marque "Add to PATH" durante a instalacao.
    echo.
    pause
    exit /b 1
)
echo [OK] Node.js encontrado:
node --version

:: Verifica npm
npm --version >nul 2>&1
if errorlevel 1 (
    echo [ERRO] npm nao encontrado. Reinstale o Node.js.
    pause
    exit /b 1
)

:: Instala dependencias
echo.
echo [INFO] Instalando dependencias (pode demorar alguns minutos)...
npm install
if errorlevel 1 (
    echo [ERRO] Falha ao instalar dependencias.
    pause
    exit /b 1
)
echo [OK] Dependencias instaladas.

:: Compila TypeScript
echo.
echo [INFO] Compilando TypeScript...
npm run build
if errorlevel 1 (
    echo [ERRO] Falha na compilacao TypeScript.
    pause
    exit /b 1
)
echo [OK] Compilacao concluida.

:: Verifica .env
if not exist .env (
    echo.
    echo ╔════════════════════════════════════════════════════════╗
    echo ║  ATENÇÃO: Configure o arquivo .env antes de rodar!    ║
    echo ║                                                        ║
    echo ║  Copie .env.example para .env e preencha:             ║
    echo ║    DISCORD_TOKEN=seu_token_aqui                       ║
    echo ║    CHANNEL_ID=id_do_canal_aqui                        ║
    echo ║                                                        ║
    echo ║  Depois execute: rodar.bat                            ║
    echo ╚════════════════════════════════════════════════════════╝
) else (
    echo.
    echo Instalacao concluida! Execute rodar.bat para iniciar.
)
echo.
pause