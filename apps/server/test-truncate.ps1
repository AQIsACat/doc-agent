1..8 | ForEach-Object {
    $body = '{"sessionId":"test-truncate","message":"message ' + $_ + '","systemMessage":"you are an assistant"}'
    $body | Out-File -Encoding utf8 body.json
    curl.exe -s -N -X POST http://localhost:3000/api/chat -H "Content-Type: application/json" -d "@body.json" | Out-Null
    Write-Host "round $_ done"
}