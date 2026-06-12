@echo off
rem claude-relay CLI shim — runs relay.ps1 regardless of execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0relay.ps1" %*
