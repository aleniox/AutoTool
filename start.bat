@echo off
chcp 65001 >nul
echo Dang khoi dong AutoTool (Python / FastAPI)...
if exist .venv\Scripts\python.exe (
    .venv\Scripts\python.exe main.py
) else (
    python main.py
)
pause
