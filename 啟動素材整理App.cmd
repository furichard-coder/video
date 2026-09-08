@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo App dependencies are missing. Run npm install first.
  pause
  exit /b 1
)

if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

call npm start

