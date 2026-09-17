@echo off
cd "C:\Users\Windows 11\Documents\cre-command\packages\api"
set AUTH_BYPASS=true
set NODE_ENV=development
echo Starting API server with AUTH_BYPASS=true and NODE_ENV=development...
call npx tsx src/index.ts