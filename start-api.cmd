@echo off
cd "C:\Users\Windows 11\Documents\cre-command\packages\api"
set AUTH_BYPASS=true
set NODE_ENV=development
echo Starting API server...
call npx tsx src/index.ts
echo Server process started