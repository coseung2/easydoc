<#
  Terminates only the Hancom automation processes recorded by
  scripts/hwpx/hwpx-to-pdf.ps1 in its ownership file. Used after a timeout,
  when the helper was killed before its own cleanup could run.

  A pid is stopped only when it is still an hwp.exe started at exactly the
  recorded instant, so a recycled pid or the user's own Hancom session is left
  alone. Before terminating, the owned process is inspected read-only for an
  open Hancom message box, so the caller can say why the render never finished.
  The dialog is never clicked, focused, or closed.

  Prints one JSON line:
    {"stopped":[2452],"skipped":[],"dialog":true}
#>
param([Parameter(Mandatory = $true)][string]$OwnershipFile)

$ErrorActionPreference = 'Stop'
$stopped = @()
$skipped = @()
$dialog = $false

function Test-DialogWindow([int]$processId) {
  # Hancom's prompts are WPF message boxes, so the Win32 class is a generic
  # HwndWrapper; UI Automation reports the real 'MessageBoxImpl' class. Scoped
  # to the owned pid, read-only.
  try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $processId)
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Children, $condition)
    foreach ($window in $windows) {
      if ($window.Current.ClassName -match 'MessageBox|Dialog') { return $true }
    }
  } catch {
    return $false
  }
  return $false
}

try {
  if (Test-Path -LiteralPath $OwnershipFile) {
    $data = Get-Content -LiteralPath $OwnershipFile -Raw | ConvertFrom-Json
    foreach ($entry in @($data.processes)) {
      $live = Get-Process -Id ([int]$entry.pid) -ErrorAction SilentlyContinue
      if (-not $live) { continue }
      $startedAt = ''
      try { $startedAt = $live.StartTime.ToString('o') } catch { $startedAt = '' }
      if ($live.ProcessName -ine 'hwp' -or -not $startedAt -or $startedAt -ne $entry.startedAt) {
        $skipped += [int]$entry.pid
        continue
      }
      # Read-only observation: an open message box explains the stall. Nothing
      # is clicked or closed, and no other process is inspected.
      if (Test-DialogWindow ([int]$live.Id)) { $dialog = $true }
      try { Stop-Process -Id $live.Id -Force -ErrorAction Stop; $stopped += [int]$live.Id } catch { $skipped += [int]$live.Id }
    }
    Remove-Item -LiteralPath $OwnershipFile -Force -ErrorAction SilentlyContinue
  }
  @{ stopped = @($stopped); skipped = @($skipped); dialog = $dialog } | ConvertTo-Json -Compress
} catch {
  @{ stopped = @($stopped); skipped = @($skipped); dialog = $dialog; error = [string]$_.Exception.Message } |
    ConvertTo-Json -Compress
}
