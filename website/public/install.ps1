$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$AreebPackage = "@ziyad_1440/areeb"
$BunInstallerUrl = "https://bun.sh/install.ps1"
$OriginalPathEntries = $env:Path -split ";"

function Find-Bun {
    $command = Get-Command bun -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $candidates = @()
    if ($env:BUN_INSTALL) {
        $candidates += Join-Path $env:BUN_INSTALL "bin\bun.exe"
    }
    if ($env:USERPROFILE) {
        $candidates += Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

$bun = Find-Bun
if (-not $bun) {
    Write-Host "Areeb requires Bun."
    Write-Host "Bun was not found, so the official Bun installer will run now."

    $installer = Invoke-RestMethod -Uri $BunInstallerUrl
    Invoke-Expression $installer

    $bun = Find-Bun
    if (-not $bun) {
        throw "Bun was installed but its executable could not be found. Restart PowerShell, then run: bun add --global $AreebPackage"
    }
}

Write-Host "Installing Areeb with $bun ..."
& $bun add --global $AreebPackage
if ($LASTEXITCODE -ne 0) {
    throw "Bun could not install Areeb."
}

$toolBinOutput = & $bun pm bin --global
if ($LASTEXITCODE -ne 0) {
    throw "Bun could not locate its global executable directory."
}

$toolBinLine = $toolBinOutput | Select-Object -Last 1
if (-not $toolBinLine) {
    throw "Bun returned an empty global executable directory."
}

$toolBin = $toolBinLine.Trim()
$env:Path = "$toolBin;$env:Path"

$areeb = Get-Command areeb -ErrorAction SilentlyContinue
if (-not $areeb) {
    throw "Areeb was installed but its command could not be found in $toolBin."
}

$areebPath = $areeb.Source
& $areebPath --help | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Areeb was installed but could not be started."
}

Write-Host "Areeb is installed. Run: areeb"

if ($toolBin -notin $OriginalPathEntries) {
    Write-Host "Restart PowerShell if 'areeb' is not found."
    Write-Host "The directory $toolBin must be on PATH."
}
