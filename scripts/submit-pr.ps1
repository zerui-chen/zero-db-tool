
$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'
$log = 'D:\kaifawork\AIWORK\zero-db-tool\.pr-result.txt'
function Write-Log($text) { ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + ' ' + $text) | Add-Content -Path $log -Encoding utf8 }

$target = Get-Date '2026-11-20 09:40:00'
while ((Get-Date) -lt $target) { Start-Sleep -Seconds 30 }
Write-Log 'start'

$nl = [char]10
$cred = ('protocol=https' + $nl + 'host=github.com' + $nl + $nl | git credential fill 2>$null)
$pass = ($cred | Select-String '^password=').Line -replace '^password=',''
$h = @{ Authorization = ('Bearer ' + $pass); 'User-Agent' = 'zero-db-tool'; 'Accept' = 'application/vnd.github+json' }

function Get-OurPrCount {
  $q = [uri]::EscapeDataString('repo:awesome-dsh-plugin/awesome-dsh-plugin author:zerui-chen')
  $r = Invoke-WebRequest -UseBasicParsing -Uri ('https://api.github.com/search/issues?q=' + $q) -Headers $h -TimeoutSec 25
  return ($r.Content | ConvertFrom-Json).total_count
}

$prBody = 'Adds a DSH database workbench: connection dropdown, object tree, data/schema/SQL tabs, read-only-first sql_* tools for SQLite/PostgreSQL/MySQL.' + [char]10 + [char]10 + '- public repo, dsh.bundle + cordis.patch.yml present' + [char]10 + '- v1.0.0 release tarball' + [char]10 + '- repo topic dsh-plugin set'

$url = ''
for ($i = 1; $i -le 8; $i++) {
  try {
    if ((Get-OurPrCount) -gt 0) { Write-Log 'already-exists'; break }
    $body = @{ title = 'Add zerui-chen/zero-db-tool'; head = 'zerui-chen:main'; base = 'main'; body = $prBody } | ConvertTo-Json
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls' -Headers $h -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
    $j = $r.Content | ConvertFrom-Json
    $url = $j.html_url
    Write-Log ('created ' + $url)
    break
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $reader = New-Object IO.StreamReader($resp.GetResponseStream())
      $text = $reader.ReadToEnd()
      Write-Log ('attempt ' + $i + ' failed ' + [int]$resp.StatusCode + ' ' + $text)
      if ($text -match 'already exists') { Write-Log 'already-exists'; break }
    } else { Write-Log ('attempt ' + $i + ' error ' + $_.Exception.Message) }
    Start-Sleep -Seconds 60
  }
}
if ($url -eq '') { Write-Log 'done-no-url' } else { Write-Log ('done ' + $url) }
