@echo off
:: ============================================================
::  SETUP-TALLY-TASK  —  Run this ONCE on the office laptop.
::  (Right-click → Run as administrator recommended)
::
::  NO Node.js is required on this laptop — the agent already
::  runs as the self-contained dist\tally-agent.exe.
::
::  What it does:
::    1. Registers a Windows scheduled task "TallyConnectSync":
::         - runs at every user log-on
::         - repeats every 30 minutes while the laptop is on
::         - catches up missed runs automatically
::       → the non-technical user never touches anything.
::    2. Puts a "Sync Tally" shortcut on the Desktop as a manual
::       "update right now" button (plain-language result).
::
::  BEFORE RUNNING: edit .env and set TALLY_COMPANY_NAME to the
::  exact company name shown in Tally. Then run this once.
::
::  (If dist\tally-agent.exe is missing, the .exe was built on the
::   IT person's PC and copied here — see the setup steps.)
:: ============================================================

cd /d "%~dp0"

echo.
echo [1/3] Checking that the agent .exe is present...
if not exist "tally-agent.exe" (
    echo  ERROR: tally-agent.exe not found in this folder.
    echo  Please copy the FULL tally-connect folder ^(including tally-agent.exe^
    echo  and .env^) from the IT person's PC, then run this again.
    echo.
    pause
    exit /b 1
)
echo  Found tally-agent.exe — no Node.js needed.

echo.
echo [2/3] Registering scheduled task "TallyConnectSync"...
set "EXEPATH=%~dp0tally-agent.exe"
set "WORKDIR=%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$exe = '%EXEPATH%'; $wd = '%WORKDIR%';" ^
  "$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $wd;" ^
  "$logonTrigger = New-ScheduledTaskTrigger -AtLogOn;" ^
  "$timeTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date);" ^
  "$timeTrigger.Repetition = New-ScheduledTaskRepetitionPattern -Interval 'PT30M' -Duration 'P999D';" ^
  "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -Hidden -ExecutionTimeLimit (New-TimeSpan -Hours 1);" ^
  "$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive;" ^
  "Register-ScheduledTask -TaskName 'TallyConnectSync' -Action $action -Trigger @($logonTrigger,$timeTrigger) -Settings $settings -Principal $principal -Description 'Syncs Tally Credit Notes to the cloud every 30 minutes and at log-on.' -Force | Out-Null;" ^
  "Write-Host '  Task registered: log-on + every 30 min, missed runs caught up, runs hidden.'"
if errorlevel 1 (
    echo  ERROR: Could not register the task. Try right-click → Run as administrator.
    pause
    exit /b 1
)

echo.
echo [3/3] Creating desktop shortcut...
set "BATFILE=%~dp0sync-tally.bat"
set "VBSFILE=%TEMP%\tally_shortcut.vbs"
> "%VBSFILE%" echo Set ws = CreateObject("WScript.Shell")
>> "%VBSFILE%" echo Set sc = ws.CreateShortcut(ws.SpecialFolders("Desktop") ^& "\Sync Tally.lnk")
>> "%VBSFILE%" echo sc.TargetPath = "%BATFILE%"
>> "%VBSFILE%" echo sc.WorkingDirectory = "%~dp0"
>> "%VBSFILE%" echo sc.Description = "Double-click to sync Tally data"
>> "%VBSFILE%" echo sc.Save
cscript //nologo "%VBSFILE%"
del "%VBSFILE%" 2>nul
echo  Shortcut "Sync Tally" placed on the Desktop.

echo.
echo ══════════════════════════════════════════════════════════
echo  SETUP COMPLETE.
echo  Confirm these ONE-TIME manual steps are done:
echo   1. .env in this folder has the correct TALLY_COMPANY_NAME.
echo   2. In Tally once: F12 → Settings → Connectivity → Enable
echo      HTTP port 9000. (Persists after this.)
echo   3. Double-click "Sync Tally" on the Desktop to test.
echo ══════════════════════════════════════════════════════════
echo.
pause
