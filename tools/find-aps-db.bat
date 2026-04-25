@echo off
REM ─────────────────────────────────────────────────────────────────────
REM  APS database locator
REM  Double-click this file. It searches common Auto Power Suite install
REM  paths for known database file types and writes the results to
REM  aps-db-found.txt next to this script.
REM ─────────────────────────────────────────────────────────────────────
setlocal EnableDelayedExpansion
set "OUT=%~dp0aps-db-found.txt"
> "%OUT%" echo APS database scan - %DATE% %TIME%
>>"%OUT%" echo.

set "ROOTS="
set "ROOTS=!ROOTS! C:\Program Files\METEORSOFT"
set "ROOTS=!ROOTS! C:\Program Files (x86)\METEORSOFT"
set "ROOTS=!ROOTS! C:\ProgramData\METEORSOFT"
set "ROOTS=!ROOTS! C:\Users\Public\Documents\METEORSOFT"
set "ROOTS=!ROOTS! C:\METEORSOFT"
set "ROOTS=!ROOTS! D:\METEORSOFT"
set "ROOTS=!ROOTS! D:\Data\METEORSOFT"

set "EXTS=fdb gdb mdb accdb sqlite db mdf sdf dbf"

for %%R in (%ROOTS%) do (
  if exist "%%~R" (
    >>"%OUT%" echo === ROOT: %%~R ===
    for %%E in (%EXTS%) do (
      for /f "delims=" %%F in ('dir /S /B "%%~R\*.%%E" 2^>nul') do (
        for %%A in ("%%F") do >>"%OUT%" echo   %%~zA bytes  ^|  %%~tA  ^|  %%F
      )
    )
    >>"%OUT%" echo.
  )
)

REM Also check common system-wide locations
>>"%OUT%" echo === System-wide *.fdb / *.gdb scan (drives C and D, top folders) ===
for %%E in (fdb gdb) do (
  for /f "delims=" %%F in ('dir /S /B C:\%%E 2^>nul') do >>"%OUT%" echo   %%F
  for /f "delims=" %%F in ('dir /S /B D:\%%E 2^>nul') do >>"%OUT%" echo   %%F
)

>>"%OUT%" echo.
>>"%OUT%" echo Scan complete.
echo.
echo ===============================================================
echo  Done. Results saved to:
echo    %OUT%
echo.
echo  Send the file content (or take a screenshot) so I can build
echo  the local sync agent for you.
echo ===============================================================
echo.
pause
