# Link the harness workspace packages this plugin imports at runtime into a
# local node_modules tree, so Node can resolve bare specifiers when the plugin
# is mounted by absolute path (cordis.patch.yml insert) outside any install
# tree. Idempotent: existing links are replaced.
$ErrorActionPreference = 'Stop'

$pluginRoot = Split-Path -Parent $PSScriptRoot
$harness = Join-Path (Split-Path -Parent $pluginRoot) 'deepseek-harness'
if (-not (Test-Path $harness)) { $harness = 'D:\DEEPSEEK\deepseek-harness' }

$targets = @{
  '@deepseek-ai/cordis'    = Join-Path $harness 'vendor\cordis'
  '@deepseek-ai/dsh-tools' = Join-Path $harness 'packages\core\tools'
  '@deepseek-ai/dsh-agent' = Join-Path $harness 'packages\core\agent'
  '@deepseek-ai/dsh-llm'   = Join-Path $harness 'packages\llm\llm'
}

foreach ($name in $targets.Keys) {
  $source = $targets[$name]
  if (-not (Test-Path (Join-Path $source 'package.json'))) {
    throw "missing package.json under $source - build deepseek-harness first"
  }
  $link = Join-Path $pluginRoot ("node_modules\" + $name)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $link) | Out-Null
  if (Test-Path $link) { Remove-Item $link -Force -Recurse }
  New-Item -ItemType Junction -Path $link -Target $source | Out-Null
  Write-Host "linked $name -> $source"
}

Write-Host 'done.'
