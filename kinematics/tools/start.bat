@echo off
cd /d "%~dp0"
echo Starting IK Workbench at http://localhost:8123
start "" http://localhost:8123
python "%~dp0serve.py" 8123
