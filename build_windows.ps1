<#
build_windows.ps1

Requires:
  - Visual Studio 2022 Build Tools (C++ / MSVC workload)
  - Rust toolchain (x86_64-pc-windows-msvc) on PATH

Run (from the project root):
  powershell -ExecutionPolicy Bypass -File .\build_windows.ps1

Output:
  dist\llm_proxy_configurator.exe

Notes:
  - This is a Tauri v2 app: `cargo build --release` (driven by tauri-build)
    embeds the web assets (../web) and the app icon automatically. The
    resulting exe already uses the WINDOWS subsystem (GUI, no console), so
    no editbin step is needed.
  - Tauri embeds a VERSIONINFO resource in every build.
  - cargo uses a dedicated target dir (target-build) so a build can never
    lock a running llm_proxy_configurator.exe.
  - This public script intentionally does no path-privacy remap or
    post-build scrub/check.
#>
$ErrorActionPreference = 'Stop'
$root  = $PSScriptRoot
Set-Location $root

# --- 1) Locate the VS C++ (MSVC) toolset via vswhere (no hardcoded path) ---
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$vswhere = Join-Path $pf86 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'vswhere not found. Install VS 2022 Build Tools (C++ workload).' }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'No Visual Studio with the C++ (MSVC) workload found.' }

# --- 2) Import the MSVC dev environment (vcvars64) into this process ---
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
$envDump = & cmd.exe /c "`"$vcvars`" >nul 2>&1 && set"
foreach ($line in $envDump) {
    if ($line -match '^([^=]+)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
}

# Ensure cargo is on PATH (fallback to the standard location).
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    $cargoHome = Join-Path $env:USERPROFILE '.cargo\bin'
    if (Test-Path $cargoHome) { $env:PATH = "$cargoHome;$env:PATH" }
}
if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) { throw 'cargo not found. Install the Rust toolchain.' }

# --- 3) cargo build (release): static CRT, no path-privacy remap ---
# Tauri (tauri-build) embeds ../web and the icon; no separate frontend step.
Set-Location (Join-Path $root 'src-tauri')
$env:RUSTFLAGS = '-C target-feature=+crt-static'
& cargo build --release --target-dir target-build
if ($LASTEXITCODE -ne 0) { throw 'cargo build failed.' }

# --- 4) Copy to dist as llm_proxy_configurator.exe ---
$exe = Join-Path $root 'src-tauri\target-build\release\llm_proxy_configurator.exe'
if (-not (Test-Path $exe)) { throw "Built exe not found: $exe" }
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Copy-Item -Force $exe (Join-Path $dist 'llm_proxy_configurator.exe')

Write-Host "Built: $dist\llm_proxy_configurator.exe"
