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
  [string]$ConfigDir = "",
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
if (-not $ConfigDir) { $ConfigDir = Join-Path $HOME ".dsh-muteki" }
$boardDir = Join-Path $DshHome "skills\muteki-board"
$boardPy = Join-Path $boardDir "board.py"
$patchPath = Join-Path $profileDir "cordis.patch.yml"
$configPath = Join-Path $ConfigDir "config.json"

Write-Host "DSH_HOME : $DshHome"
Write-Host "Profile  : $profileDir"
Write-Host "Python   : $Python"
Write-Host "Board    : $boardPy"
Write-Host "Storage  : $StorageDir"
Write-Host "Config   : $configPath"
Write-Host ""

# 0) 已安装检测
if ((Test-Path $patchPath) -and (Select-String -Path $patchPath -Pattern "id: preset-muteki" -Quiet) -and -not $Force) {
  throw "profile 里已经有 preset-muteki。要重装请加 -Force（会重复插入，建议先手动删掉旧段）。"
}
# 0b) market 版预设检测：bundle 的 patch 已含 preset-muteki，再手动追加会 insert id 重复
$pkgJsonPath = Join-Path $profileDir "package.json"
$pkgJson = $null
if (Test-Path $pkgJsonPath) { $pkgJson = Get-Content $pkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json }
$bundles = @()
if ($pkgJson -and $pkgJson.dsh -and $pkgJson.dsh.profile -and $pkgJson.dsh.profile.bundles) { $bundles = @($pkgJson.dsh.profile.bundles) }
if (($bundles -contains "muteki-preset") -and -not $Force) {
  throw "market 已安装 muteki-preset（预设本体 bundle），与手动安装二选一。要继续手动安装：先从 dsh.profile.bundles 移除 muteki-preset 并卸载依赖，或加 -Force 自负重复风险。"
}

# 1) 黑板
New-Item -ItemType Directory -Force $boardDir | Out-Null
Copy-Item (Join-Path $root "board\board.py") $boardPy -Force
$skill = Get-Content (Join-Path $root "board\SKILL.md") -Raw
$skill = $skill.Replace("{{PYTHON}}", $Python).Replace("{{BOARD_PY}}", $boardPy).Replace("{{STORAGE_DIR}}", $StorageDir)
Set-Content -Path (Join-Path $boardDir "SKILL.md") -Value $skill -Encoding UTF8

# 1b) 安装配置：board.py 靠它定位证据目录（A3）。
#     优先级：MUTEKI_ARTIFACT_DIR 环境变量 > 本文件的 storage_dir > 内置默认。
#     用 .NET 写 UTF8 无 BOM，兼容 PowerShell 5.1 与 7（BOM 会让 json 解析失败）。
New-Item -ItemType Directory -Force $ConfigDir | Out-Null
$version = (Get-Content (Join-Path $root "plugins\dsh-muteki-orchestrator\package.json") -Raw | ConvertFrom-Json).version
$cfg = [ordered]@{
  python      = $Python
  board_py    = $boardPy
  storage_dir = $StorageDir
  config_dir  = $ConfigDir
  version     = $version
}
$json = $cfg | ConvertTo-Json
[System.IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[1/4] 黑板已安装：$boardDir"
Write-Host "      配置已写入：$configPath（storage_dir=$StorageDir，version=$version）"

# 2) 插件：直接放 profile 根目录，用相对路径挂载（不进 node_modules，pnpm install 不会移走）
Copy-Item (Join-Path $root "plugins\dsh-muteki-orchestrator\plugin-v13.mjs") (Join-Path $profileDir "muteki-orchestrator.mjs") -Force
Copy-Item (Join-Path $root "plugins\muteki-core\muteki-core.mjs") (Join-Path $profileDir "muteki-core.mjs") -Force
Write-Host "[2/4] 插件已安装：$profileDir\muteki-orchestrator.mjs"

# 2b) 工作台小包：profile 根目录放包 + junction 进 node_modules + 声明 file: 依赖。
#     包带 dsh.bundle / dsh.client 声明，pnpm install 不会移走；右侧栏 UI 与设置路由由此生效。
$wbSrc = Join-Path $root "plugins\muteki-workbench"
$wbDst = Join-Path $profileDir "muteki-workbench-pkg"
# market 已装工作台（进白名单且依赖不是本地 file:）→ 跳过本地拷贝，避免两套包版本错位
$wbDep = $null
if ($pkgJson -and $pkgJson.dependencies -and $pkgJson.dependencies.PSObject.Properties.Name -contains "muteki-workbench") {
  $wbDep = $pkgJson.dependencies."muteki-workbench"
}
if (($bundles -contains "muteki-workbench") -and $wbDep -and ("$wbDep" -notlike "file:*")) {
  Write-Host "[2b/4] 跳过：market 已安装 muteki-workbench（依赖=$wbDep），不用本地拷贝覆盖" -ForegroundColor Yellow
  $wbDst = $null
}
if ($wbDst -and (Test-Path (Join-Path $wbDst "package.json"))) {
  $wbName = (Get-Content (Join-Path $wbDst "package.json") -Raw | ConvertFrom-Json).name
  if ($wbName -ne "muteki-workbench") {
    Write-Host "[2b/4] 跳过：$wbDst 已被其它包占用（name=$wbName）" -ForegroundColor Yellow
    $wbDst = $null
  }
}
if ($wbDst) {
  if (Test-Path $wbDst) { Remove-Item $wbDst -Recurse -Force }
  Copy-Item $wbSrc $wbDst -Recurse -Force
  $wbLink = Join-Path $profileDir "node_modules\muteki-workbench"
  if (-not (Test-Path $wbLink)) {
    New-Item -ItemType Junction -Path $wbLink -Target $wbDst | Out-Null
  }
  $pkgPath = Join-Path $profileDir "package.json"
  if (Test-Path $pkgPath) {
    $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
    if (-not $pkg.dependencies) {
      $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([ordered]@{})
    }
    if ($pkg.dependencies.PSObject.Properties.Name -notcontains "muteki-workbench") {
      $pkg.dependencies | Add-Member -NotePropertyName "muteki-workbench" -NotePropertyValue "file:./muteki-workbench-pkg"
    }
    # DSH 只加载 dsh.profile.bundles 白名单里的 bundle；只加依赖不进名单=服务端不挂载、UI 不出现
    if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([ordered]@{}) }
    if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([ordered]@{}) }
    if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }
    if ($pkg.dsh.profile.bundles -notcontains "muteki-workbench") {
      $pkg.dsh.profile.bundles += "muteki-workbench"
    }
    $pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgPath -Encoding UTF8
  }
  Write-Host "[2b/4] 工作台已安装：$wbDst（junction + file: 依赖 + bundles 白名单；重启 DSH 后右侧栏出现「Muteki 工作台」）"
}

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
  Write-Host "下一步：完整重启 DSH Desktop（预设注册表在进程启动时建树，只新开会话不够），在预设列表里选「Muteki 蜂群」。" -ForegroundColor Green
} else {
  Write-Host "[4/4] 未写入 patch（加 -Apply 自动追加）"
  Write-Host ""
  Write-Host "手动步骤：把 $outFile 的内容追加到" -ForegroundColor Yellow
  Write-Host "  $patchPath" -ForegroundColor Yellow
  Write-Host "然后完整重启 DSH Desktop（只新开会话不够），在预设列表里选「Muteki 蜂群」。"
}
