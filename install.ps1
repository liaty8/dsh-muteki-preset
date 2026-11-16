#Requires -Version 5.1
<#
.SYNOPSIS
  安装 Muteki 蜂群 DSH 预设（黑板 + 派单插件 + 证据捕获）。
.DESCRIPTION
  不跑 pnpm、不装 bundle，只复制文件 + 生成 patch 片段。
  -Apply 会把片段追加到 profile 的 cordis.patch.yml（先备份）。
.PARAMETER Apply
  自动追加到 profile 的 cordis.patch.yml。
.PARAMETER Force
  即使已经存在 preset-muteki 也继续（默认检测到就停止）。
#>
param(
  [string]$DshHome = $env:DSH_HOME,
  [string]$Profile = "desktop",
  [string]$Python = "python",
  [string]$ClaudeBin = "claude",
  [string]$ClaudeConfigDir = "",
  [string]$StorageDir = "",
  [switch]$Apply,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $DshHome) {
  $DshHome = Join-Path $HOME "dsh\home"
  if (-not (Test-Path $DshHome)) { $DshHome = Join-Path $HOME ".dsh" }
}
$profileDir = Join-Path $DshHome "profiles\$Profile"
if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录：$profileDir（用 -Profile 指定，如 desktop / web）" }

if (-not $StorageDir) { $StorageDir = Join-Path $HOME ".dsh-muteki\artifacts" }
$boardDir = Join-Path $DshHome "skills\muteki-board"
$boardPy = Join-Path $boardDir "board.py"
$patchPath = Join-Path $profileDir "cordis.patch.yml"

Write-Host "DSH_HOME : $DshHome"
Write-Host "Profile  : $profileDir"
Write-Host "Python   : $Python"
Write-Host "Board    : $boardPy"
Write-Host "Storage  : $StorageDir"
Write-Host ""

# 0) 已安装检测
if ((Test-Path $patchPath) -and (Select-String -Path $patchPath -Pattern "id: preset-muteki" -Quiet) -and -not $Force) {
  throw "profile 里已经有 preset-muteki。要重装请加 -Force（会重复插入，建议先手动删掉旧段）。"
}

# 1) 黑板
New-Item -ItemType Directory -Force $boardDir | Out-Null
Copy-Item (Join-Path $root "board\board.py") $boardPy -Force
$skill = Get-Content (Join-Path $root "board\SKILL.md") -Raw
$skill = $skill.Replace("{{PYTHON}}", $Python).Replace("{{BOARD}}", $boardPy).Replace("{{STORAGE}}", $StorageDir)
Set-Content -Path (Join-Path $boardDir "SKILL.md") -Value $skill -Encoding UTF8
Write-Host "[1/4] 黑板已安装：$boardDir"

# 2) 插件：直接放 profile 根目录，用相对路径挂载（不进 node_modules，pnpm install 不会移走）
Copy-Item (Join-Path $root "plugins\dsh-muteki-orchestrator\plugin-v13.mjs") (Join-Path $profileDir "muteki-orchestrator.mjs") -Force
Copy-Item (Join-Path $root "plugins\muteki-core\muteki-core.mjs") (Join-Path $profileDir "muteki-core.mjs") -Force
Write-Host "[2/4] 插件已安装：$profileDir\muteki-orchestrator.mjs"

# 3) 生成片段
$tpl = Get-Content (Join-Path $root "preset\preset-muteki.patch.yml") -Raw
$tpl = $tpl.Replace("{{PYTHON}}", $Python)
$tpl = $tpl.Replace("{{BOARD_PY}}", $boardPy)
$tpl = $tpl.Replace("{{STORAGE_DIR}}", $StorageDir)
$tpl = $tpl.Replace("{{CLAUDE_BIN}}", $ClaudeBin)
$tpl = $tpl.Replace("{{CLAUDE_CONFIG_DIR}}", $ClaudeConfigDir)
$core = @"

- insert:
    - id: muteki-core
      name: ./muteki-core.mjs
      config:
        artifactDir: '$StorageDir'
        maxPayloadBytes: 2097152
        enabled: true
"@
$block = $tpl.TrimEnd() + "`n" + $core
$outFile = Join-Path $root "preset-muteki.generated.yml"
Set-Content -Path $outFile -Value $block -Encoding UTF8
Write-Host "[3/4] 已生成：$outFile"

# 4) 可选写入
if ($Apply) {
  $bak = "$patchPath.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
  Copy-Item $patchPath $bak -Force
  Add-Content -Path $patchPath -Value "`n$block" -Encoding UTF8
  Write-Host "[4/4] 已追加到 $patchPath（备份：$bak）"
  Write-Host ""
  Write-Host "下一步：重启 DSH 或新开会话，在预设列表里选「Muteki 蜂群」。" -ForegroundColor Green
} else {
  Write-Host "[4/4] 未写入 patch（加 -Apply 自动追加）"
  Write-Host ""
  Write-Host "手动步骤：把 $outFile 的内容追加到" -ForegroundColor Yellow
  Write-Host "  $patchPath" -ForegroundColor Yellow
  Write-Host "然后新开会话，在预设列表里选「Muteki 蜂群」。"
}
