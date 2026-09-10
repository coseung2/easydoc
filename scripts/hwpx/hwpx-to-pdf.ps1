<#
  Renders one saved HWPX file to PDF with the locally installed Hancom Office
  (HWPFrame.HwpObject automation). Single shot, isolated, STA: the caller runs
  this in a hidden child process, one file per invocation, and owns queueing,
  hashing, caching, and the timeout.

  Contract
    stdout: exactly one JSON line
      {"ok":true,"pdfPath":"...","hancomVersion":"12.0.0.3146","stage":"done"}
      {"ok":false,"error":"...","stage":"open"}
    -OwnershipFile: written right after the automation instance exists, holding
      only the hwp.exe process this invocation owns:
        {"processes":[{"pid":2452,"startedAt":"<ISO>"}]}

  Ownership rule (hard requirement)
    A process counts as owned only when our own automation window handle
    (XHwpWindows.Item(0).WindowHandle) resolves to that pid AND the pid did not
    exist before this invocation created the COM object. Without that proof the
    script opens nothing, does not call Clear/Quit (which would close a
    document belonging to the user or to another integration such as a school
    administration tool), releases the COM reference only, and reports an error.
    Terminating is likewise limited to a re-proved pid: same image name, same
    start instant. A generic `taskkill /IM hwp.exe` is never acceptable.

  Fidelity policy: no forceopen / versionwarning / message-box suppression.
  A document that Hancom would only open through repair, or that raises a
  prompt, must fail (or hit the caller's timeout) instead of silently producing
  a PDF that hides the problem. This script never saves the source, and never
  registers, unregisters, or edits any security module or registry value.
#>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Output,
  [string]$OwnershipFile = ''
)

$ErrorActionPreference = 'Stop'
$stage = 'start'
$hwp = $null
$owned = @()
$ownedProven = $false

Add-Type -Namespace HwpxPreview -Name NativeWindow -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true)]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
'@

function Get-HwpProcessIds {
  $ids = @{}
  foreach ($p in @(Get-Process -Name 'hwp' -ErrorAction SilentlyContinue)) { $ids[[int]$p.Id] = $true }
  return $ids
}

function Get-ProcessStartedAt([int]$processId) {
  $p = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if (-not $p -or $p.ProcessName -ine 'hwp') { return '' }
  try { return $p.StartTime.ToString('o') } catch { return '' }
}

function Write-Ownership($processes) {
  if (-not $OwnershipFile) { return }
  $payload = @{ processes = @($processes) } | ConvertTo-Json -Compress -Depth 4
  Set-Content -LiteralPath $OwnershipFile -Value $payload -Encoding UTF8
}

function Stop-OwnedProcesses($processes) {
  foreach ($entry in @($processes)) {
    $live = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
    if (-not $live) { continue }
    $startedAt = ''
    try { $startedAt = $live.StartTime.ToString('o') } catch { $startedAt = '' }
    # Re-prove ownership: same image, same start instant. A recycled pid or an
    # unrelated process must survive untouched.
    if ($live.ProcessName -ine 'hwp' -or -not $startedAt -or $startedAt -ne $entry.startedAt) { continue }
    try { Stop-Process -Id $live.Id -Force -ErrorAction Stop } catch { }
  }
}

try {
  if (-not (Test-Path -LiteralPath $Source)) { throw "Source file not found: $Source" }
  $sourceFull = (Resolve-Path -LiteralPath $Source).ProviderPath
  $outputFull = [System.IO.Path]::GetFullPath($Output)
  # Never let the output path collide with the input: the cleanup below deletes
  # an existing output file, which would destroy the document being previewed.
  if ([string]::Equals($sourceFull, $outputFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output path must differ from the source document'
  }
  $outputDirectory = Split-Path -Parent $Output
  if ($outputDirectory -and -not (Test-Path -LiteralPath $outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  }
  if (Test-Path -LiteralPath $outputFull) { Remove-Item -LiteralPath $outputFull -Force }

  $preexisting = Get-HwpProcessIds
  $stage = 'create'
  $hwp = New-Object -ComObject 'HWPFrame.HwpObject'

  $stage = 'own'
  $window = $null
  try { $window = $hwp.XHwpWindows.Item(0) } catch { $window = $null }
  if ($window) {
    $handle = 0
    try { $handle = [int64]$window.WindowHandle } catch { $handle = 0 }
    if ($handle -ne 0) {
      $resolved = 0
      [void][HwpxPreview.NativeWindow]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$resolved)
      $resolvedId = [int]$resolved
      # Only a process that this invocation created counts as owned.
      if ($resolvedId -gt 0 -and -not $preexisting.ContainsKey($resolvedId)) {
        $startedAt = Get-ProcessStartedAt $resolvedId
        if ($startedAt) { $owned = @([pscustomobject]@{ pid = $resolvedId; startedAt = $startedAt }) }
      }
    }
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($window) } catch { }
    $window = $null
  }
  Write-Ownership $owned
  # Without a proven owned process we must not drive this instance at all.
  if ($owned.Count -ne 1) {
    throw 'Could not prove ownership of a Hancom automation process; refusing to drive an instance that may belong to the user'
  }
  $ownedProven = $true

  $version = ''
  try { $version = ([string]$hwp.Version) -replace '\s', '' -replace ',', '.' } catch { $version = '' }

  $stage = 'open'
  # lock:false leaves the saved source unlocked and unmodified while the editor
  # may still hold it. No prompt-suppressing options: see the fidelity policy.
  $opened = $hwp.Open($sourceFull, 'HWPX', 'lock:false')
  if (-not $opened) { throw 'Hancom refused to open the document' }

  $stage = 'export'
  $saved = $hwp.SaveAs($outputFull, 'PDF', '')
  if (-not $saved) { throw 'Hancom refused to export a PDF' }
  if (-not (Test-Path -LiteralPath $outputFull)) { throw 'Hancom reported success but wrote no PDF' }

  $stage = 'done'
  @{ ok = $true; pdfPath = $outputFull; hancomVersion = $version; stage = $stage } |
    ConvertTo-Json -Compress
} catch {
  @{ ok = $false; error = [string]$_.Exception.Message; stage = $stage } | ConvertTo-Json -Compress
} finally {
  if ($hwp) {
    if ($ownedProven) {
      # Discard the helper document without saving and quit this automation
      # instance only; never enumerate or close other Hancom windows.
      try { $hwp.Clear(1) } catch { }
      try { $hwp.Quit() } catch { }
    }
    # An unproven instance is only released: no Clear, no Quit.
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($hwp) } catch { }
    $hwp = $null
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
  }
  if ($ownedProven -and $owned.Count -gt 0) {
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
      $alive = @($owned | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })
      if ($alive.Count -eq 0) { break }
      Start-Sleep -Milliseconds 250
    }
    Stop-OwnedProcesses $owned
  }
  if ($OwnershipFile -and (Test-Path -LiteralPath $OwnershipFile)) {
    Remove-Item -LiteralPath $OwnershipFile -Force -ErrorAction SilentlyContinue
  }
}
