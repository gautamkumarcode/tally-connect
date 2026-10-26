@echo off
:: ============================================================
::  SYNC-TALLY  —  Double-click this to sync Tally data.
::  Made for non-technical users: you only need to read the
::  one-line result message below.
::
::  Runs tally-agent.exe — NO Node.js needed on this laptop.
::
::  If it says FAILURE: open Tally first, then double-click again.
:: ============================================================

cd /d "%~dp0"

if not exist "tally-agent.exe" (
    echo.
    echo  FAILURE: Setup missing. Please call the IT person.
    goto :done
)

:: Run the sync (exe writes a plain status file we read back below)
tally-agent.exe > nul 2>&1

:: Read the status the agent recorded
set STATUS=UNKNOWN
if exist "last-sync-status.txt" set /p STATUS=<last-sync-status.txt

if "%STATUS:SYNC_FAILED_TALLY_CLOSED=%" neq "%STATUS%" (
    echo.
    echo  FAILURE: Please OPEN TALLY first, then double-click this again.
    goto :done
)
if "%STATUS:SYNC_FAILED_CONFIG=%" neq "%STATUS%" (
    echo.
    echo  FAILURE: Setup incomplete. Please call the IT person.
    goto :done
)
if "%STATUS:SYNC_FAILED_DB=%" neq "%STATUS%" (
    echo.
    echo  FAILURE: Internet or database problem. Try again later.
    goto :done
)
if "%STATUS:SYNC_SUCCESS=%" neq "%STATUS%" (
    echo.
    echo  SUCCESS: Tally data is now synced and visible in the app.
    goto :done
)

echo.
echo  FAILURE: Something went wrong. Please call the IT person.

:done
echo.
pause
