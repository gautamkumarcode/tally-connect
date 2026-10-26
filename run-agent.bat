@echo off
:: ============================================================
::  Tally Connect — Windows Task Scheduler Launcher
::  
::  HOW TO SCHEDULE:
::  1. Open "Task Scheduler" (search in Start Menu)
::  2. Click "Create Basic Task..."
::  3. Name: "Tally Connect Sync"
::  4. Trigger: Daily → Repeat every 10 minutes indefinitely
::  5. Action: Start a Program
::     Program: C:\path\to\tally-connect\run-agent.bat
::  6. Finish → Run the task manually once to test
::
::  IMPORTANT: Set "Start In" to the folder containing this .bat file
:: ============================================================

:: Change to the directory of this script (handles Task Scheduler path issues)
cd /d "%~dp0"

:: Run the compiled agent (faster than ts-node for production)
node dist\agent.js

:: Exit with the node process exit code so Task Scheduler knows if it failed
exit /b %errorlevel%
