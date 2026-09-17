@echo off
cd "C:\Users\Windows 11\Documents\cre-command\packages\api"
echo Starting API server...
set AUTH_BYPASS=true
set NODE_ENV=development
echo AUTH_BYPASS=%AUTH_BYPASS%
echo NODE_ENV=%NODE_ENV%
echo.
echo Starting npx tsx src/index.ts...
call npx tsx src/index.ts
echo Server started (or exited with error)