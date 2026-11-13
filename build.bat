@echo off
rem Double-click this file to build RABG (runs build.py).
cd /d "%~dp0"
where python >nul 2>nul
if %errorlevel%==0 (
    python build.py
) else (
    where py >nul 2>nul
    if %errorlevel%==0 (
        py build.py
    ) else (
        echo Python was not found. Install Python 3 from python.org, then run this again.
    )
)
echo.
pause
