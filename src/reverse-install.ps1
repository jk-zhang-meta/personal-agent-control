param(
  [ValidateSet('Probe', 'Install')][string]$Action = 'Probe',
  [ValidateSet('ida', 'windbg')][string]$Provider = 'ida',
  [Parameter(Mandatory=$true)][string]$CoreRoot,
  [string]$RuntimeHome
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nativeHome = [Environment]::GetFolderPath('UserProfile')
if (!$RuntimeHome) { $RuntimeHome = $nativeHome }
$RuntimeHome = [IO.Path]::GetFullPath($RuntimeHome).TrimEnd('\')
if (!$RuntimeHome.StartsWith($nativeHome.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -and $RuntimeHome -ne $nativeHome) {
  throw 'The runtime must remain inside the current Windows user home.'
}
if ($RuntimeHome -notmatch '^[A-Za-z]:\\') { throw 'Remote runtime homes are unsupported.' }
$ancestor = $RuntimeHome
while ($ancestor) {
  if (Test-Path -LiteralPath $ancestor) {
    if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Runtime roots must not traverse reparse points.' }
  }
  $ancestor = Split-Path $ancestor -Parent
}
$toolsRoot = Join-Path $RuntimeHome '.agent-work\tools\reverse-engineering'
$workRoot = Join-Path $RuntimeHome '.agent-work\runtime\reverse-provision'
$manifest = Get-Content -LiteralPath (Join-Path $CoreRoot 'catalog\providers.json') -Raw | ConvertFrom-Json
$spec = $manifest.providers | Where-Object name -eq $Provider
if (!$spec -or $spec.versionPolicy -ne 'pinned') { throw 'A pinned provider is required.' }
$miseLock = Get-Content -LiteralPath (Join-Path $CoreRoot 'mise.lock') -Raw
function Locked-Tool([string]$name) {
  $key = if ($name -eq 'node') { 'node' } else { '"aqua:astral-sh/uv"' }
  $escaped = [regex]::Escape($key)
  $block = [regex]::Match($miseLock, '(?ms)^\[\[tools\.' + $escaped + '\]\]\r?\n(.*?)(?=^\[\[tools\.|\z)').Groups[1].Value
  $version = [regex]::Match($block, '(?m)^version = "([^"]+)"').Groups[1].Value
  $platform = [regex]::Match($block, '(?ms)^\[tools\.' + $escaped + '\."platforms.windows-x64"\]\r?\n(.*?)(?=^\[|\z)').Groups[1].Value
  $url = [regex]::Match($platform, '(?m)^url = "([^"]+)"').Groups[1].Value
  $hash = [regex]::Match($platform, '(?m)^checksum = "sha256:([a-f0-9]{64})"').Groups[1].Value
  if (!$version -or !$url.StartsWith('https://') -or !$hash) { throw "Missing PAC Windows lock for $name" }
  return @{ version=$version; url=$url; hash=$hash }
}
$nodePin = Locked-Tool 'node'
$nodeRoot = Join-Path $toolsRoot ('bootstrap\node-' + $nodePin.version)
$nativeNode = Join-Path $nodeRoot ('node-v' + $nodePin.version + '-win-x64\node.exe')
if ($Action -eq 'Probe') {
  if (!(Test-Path -LiteralPath $nativeNode -PathType Leaf)) {
    $candidate = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    $nativeNode = if (Test-Path -LiteralPath $candidate -PathType Leaf) { $candidate } else { $null }
  }
  @{home=$nativeHome; node=$nativeNode} | ConvertTo-Json -Compress
  exit 0
}
if (![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'Windows provisioning is verified for x64 only.' }
foreach ($directory in @($toolsRoot, $workRoot)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
$lockPath = Join-Path $toolsRoot '.provision.lock'
$lock = $null
$deadline = [DateTime]::UtcNow.AddMinutes(10)
while (!$lock) {
  try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch [IO.IOException] {
    if ([DateTime]::UtcNow -ge $deadline) { throw 'Another Windows provider installation owns the lock; retry after it completes.' }
    Start-Sleep -Milliseconds 500
  }
}
$attempt = Join-Path $workRoot ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $attempt | Out-Null
$env:TEMP = $attempt
$env:TMP = $attempt
function Checked-Run([string]$program, [string[]]$arguments) {
  $output = & $program @arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Provider prerequisite command failed ($LASTEXITCODE): $program`n$($output | Out-String)" }
  return $output
}
function Download-Verified([string]$url, [string]$hash, [string]$destination) {
  if (!$url.StartsWith('https://') -or $hash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid locked download.' }
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $destination -TimeoutSec 600
  if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Downloaded artifact differs from the PAC SHA-256 pin.' }
}
function Ensure-ZipTool($pin, [string]$destination, [string]$executable) {
  if (Test-Path -LiteralPath $destination) {
    if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw "Existing tool directory is incomplete; preserving $destination" }
    return
  }
  $archive = Join-Path $attempt ([Guid]::NewGuid().ToString('N') + '.zip')
  $stage = Join-Path (Split-Path $destination) ('.stage-' + [Guid]::NewGuid().ToString('N'))
  Download-Verified $pin.url $pin.hash $archive
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Checked-Run (Join-Path $env:WINDIR 'System32\tar.exe') @('-xf',$archive,'-C',$stage) | Out-Null
    Move-Item -LiteralPath $stage -Destination $destination
  } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }
}
function Wait-OwnedProcess($process) {
  if (!$process.WaitForExit(900000)) {
    try { $process.Kill() } catch {}
    throw 'Owned SDK process exceeded its 15 minute timeout.'
  }
  $process.WaitForExit()
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw "SDK process failed: $($process.ExitCode)" }
}
function Expected-Packages([string]$requirements) {
  $expected = @{}
  foreach ($line in Get-Content -LiteralPath $requirements) {
    if ($line -match '^([a-zA-Z0-9_-]+)==([^\s\\]+)') { $expected[$Matches[1].ToLowerInvariant().Replace('_','-')] = $Matches[2] }
  }
  if (!$expected.Count) { throw 'The dependency lock is empty.' }
  return $expected
}
function Verify-Environment([string]$python, $expected) {
  $code = "import importlib.metadata as m,json,sys;print(json.dumps({'python':'.'.join(map(str,sys.version_info[:3])),'packages':{d.metadata['Name'].lower().replace('_','-'):d.version for d in m.distributions()}}))"
  $actual = (Checked-Run $python @('-I','-B','-c',$code) | Out-String) | ConvertFrom-Json
  if ($actual.python -ne $spec.pythonVersion) { throw 'Existing Python version differs from the reviewed pin; environment preserved.' }
  if (@($actual.packages.PSObject.Properties).Count -ne $expected.Count) { throw 'Installed dependency inventory differs from the full lock; environment preserved.' }
  foreach ($name in $expected.Keys) {
    if ($actual.packages.$name -ne $expected[$name]) { throw "Installed dependency differs from the lock: $name; environment preserved." }
  }
  return $actual
}
try {
  Ensure-ZipTool $nodePin $nodeRoot $nativeNode
  if ((Checked-Run $nativeNode @('--version') | Out-String).Trim() -ne ('v' + $nodePin.version)) { throw 'Windows Node version mismatch.' }
  $uvPin = Locked-Tool 'uv'
  $uvRoot = Join-Path $toolsRoot ('bootstrap\uv-' + $uvPin.version)
  $uv = Join-Path $uvRoot 'uv.exe'
  Ensure-ZipTool $uvPin $uvRoot $uv
  if ((Checked-Run $uv @('--version') | Out-String) -notmatch ('^uv ' + [regex]::Escape($uvPin.version) + '(\s|$)')) { throw 'uv version mismatch.' }
  $requirements = Join-Path $CoreRoot $spec.requirements
  $expected = Expected-Packages $requirements
  $environmentRoot = Join-Path $toolsRoot $Provider
  $python = Join-Path $environmentRoot 'Scripts\python.exe'
  $env:UV_CACHE_DIR = Join-Path $attempt 'uv-cache'
  $env:UV_PYTHON_INSTALL_DIR = Join-Path $toolsRoot 'python'
  $env:UV_NO_PROGRESS = '1'
  $env:UV_PYTHON_DOWNLOADS = 'automatic'
  $env:PYTHONDONTWRITEBYTECODE = '1'
  if (Test-Path -LiteralPath $environmentRoot) {
    if (!(Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Existing provider directory is incomplete; it was not overwritten.' }
    $inventory = Verify-Environment $python $expected
  } else {
    $stage = Join-Path $toolsRoot ('.' + $Provider + '-' + [Guid]::NewGuid().ToString('N'))
    try {
      Checked-Run $uv @('venv','--quiet','--managed-python','--python',$spec.pythonVersion,'--relocatable',$stage) | Out-Null
      $stagePython = Join-Path $stage 'Scripts\python.exe'
      Checked-Run $uv @('pip','sync','--quiet','--require-hashes','--only-binary',':all:','--python',$stagePython,$requirements) | Out-Null
      $inventory = Verify-Environment $stagePython $expected
      Move-Item -LiteralPath $stage -Destination $environmentRoot
      $inventory = Verify-Environment $python $expected
    } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }
  }
  if ($Provider -eq 'windbg') {
    $cdb = Join-Path $RuntimeHome $spec.debuggerPath
    $debuggerRoot = Join-Path $toolsRoot ('debuggers-' + $spec.debuggerVersion)
    if (!(Test-Path -LiteralPath $debuggerRoot)) {
      $setup = Join-Path $attempt 'winsdksetup.exe'
      Download-Verified $spec.sdkInstaller.url $spec.sdkInstaller.sha256 $setup
      $signature = Get-AuthenticodeSignature -LiteralPath $setup
      if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'SDK installer lacks a valid Microsoft signature.' }
      $layout = Join-Path $attempt 'sdk-layout'
      $process = Start-Process -FilePath $setup -ArgumentList @('/layout', ('"' + $layout + '"'), '/features','OptionId.WindowsDesktopDebuggers','/quiet','/norestart') -WindowStyle Hidden -PassThru
      Wait-OwnedProcess $process
      $msi = @(Get-ChildItem -LiteralPath $layout -Filter 'Windows Debugging Tools-x64_en-us.msi' -Recurse -File)
      if ($msi.Count -ne 1) { throw 'The pinned SDK did not provide its expected x64 debugger MSI.' }
      $stage = Join-Path $toolsRoot ('.debuggers-' + [Guid]::NewGuid().ToString('N'))
      try {
        $process = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\msiexec.exe') -ArgumentList @('/a', ('"' + $msi[0].FullName + '"'), '/qn', ('TARGETDIR="' + $stage + '"')) -WindowStyle Hidden -PassThru
        Wait-OwnedProcess $process
        $stageCdb = Join-Path $stage 'Windows Kits\10\Debuggers\x64\cdb.exe'
        if ((Get-FileHash -LiteralPath $stageCdb -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.debuggerSha256) { throw 'Extracted CDB differs from the reviewed pin.' }
        Move-Item -LiteralPath $stage -Destination $debuggerRoot
      } finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force } }
    }
    if ((Get-FileHash -LiteralPath $cdb -Algorithm SHA256).Hash.ToLowerInvariant() -ne $spec.debuggerSha256) { throw 'Existing CDB differs from the reviewed pin; debugger preserved.' }
  }
  @{provider=$Provider;home=$RuntimeHome;node=$nativeNode;python=$inventory.python;packages=$inventory.packages;status='verified'} | ConvertTo-Json -Compress -Depth 5
} finally {
  if (Test-Path -LiteralPath $attempt) { Remove-Item -LiteralPath $attempt -Recurse -Force }
  $lock.Dispose()
}
