@echo off
cd /d "%~dp0"
where pyw >nul 2>&1
if %errorlevel%==0 (
  start "Nexus" pyw -3 "%~dp0time_widget.pyw"
  exit /b 0
)
where pythonw >nul 2>&1
if %errorlevel%==0 (
  start "Nexus" pythonw "%~dp0time_widget.pyw"
  exit /b 0
)
echo Python was not found. Install Python 3 from python.org and try again.
pause
