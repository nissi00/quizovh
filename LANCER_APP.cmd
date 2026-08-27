@echo off
setlocal
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker Desktop est requis pour lancer cette version en local.
  pause
  exit /b 1
)
cd /d "%~dp0"
docker compose up -d --build
if errorlevel 1 (
  echo Le demarrage a echoue. Consultez les messages ci-dessus.
  pause
  exit /b 1
)
start "" "http://localhost/index.html"
endlocal
