@echo off
rem BAG DCA research prototype launcher (Windows). Paths with spaces are fine: quote them.
rem   start.cmd wallet --sdk "C:\path with spaces\BagProtocolv2-integ\packages\bag-sdk"
rem   start.cmd test   --sdk "...\packages\bag-sdk"
rem   start.cmd shadow --app "C:\...\BagProtocolv2"
rem   start.cmd executor-wallet --app "C:\...\BagProtocolv2"   (your wallet: 3 signatures, no transaction)
rem   start.cmd unit
setlocal
where node >nul 2>nul || (echo Node.js 24+ is required: https://nodejs.org & exit /b 2)
node "%~dp0start.mjs" %*
exit /b %ERRORLEVEL%
