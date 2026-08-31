param(
    [string]$SourceDb = (Join-Path $PSScriptRoot '..\dictionary.db'),
    [string]$OutputZip = (Join-Path $PSScriptRoot '..\src-tauri\resources\mobile-starter-dictionaries.zip'),
    [int]$TermLimit = 10000
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $SourceDb)) {
    throw "Dictionary database not found: $SourceDb"
}

$sqlite = Get-Command sqlite3 -ErrorAction Stop
$outputDirectory = Split-Path -Parent $OutputZip
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

$temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("setsuna-mobile-dictionaries-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
$jsonlPath = Join-Path $temporaryDirectory 'mobile-starter-dictionaries.jsonl'
$normalizedSource = ([System.IO.Path]::GetFullPath($SourceDb)).Replace('\', '/')
$normalizedOutput = $jsonlPath.Replace('\', '/')

try {
    $sql = @"
.mode list
.output '$normalizedOutput'
ATTACH DATABASE '$normalizedSource' AS source;
WITH common_terms AS (
    SELECT term, MIN(value) AS frequency_rank
    FROM source.frequencies
    WHERE dict_name = 'JPDB' AND term <> ''
    GROUP BY term
    ORDER BY frequency_rank
    LIMIT $TermLimit
),
ranked_entries AS (
    SELECT
        e.term,
        COALESCE(e.reading, '') AS reading,
        e.definition,
        e.tags,
        e.dict_name,
        c.frequency_rank,
        ROW_NUMBER() OVER (
            PARTITION BY e.dict_name, e.term
            ORDER BY CASE WHEN COALESCE(e.reading, '') = '' THEN 1 ELSE 0 END, e.id
        ) AS entry_rank
    FROM source.entries e
    JOIN common_terms c ON c.term = e.term
    WHERE e.dict_name IN ('JMdict (Russian)', 'JMdict Extra')
)
SELECT json_object(
    'term', term,
    'reading', reading,
    'definition', definition,
    'tags', tags,
    'dictName', CASE
        WHEN dict_name = 'JMdict (Russian)' THEN 'Setsuna Core JP-RU'
        ELSE 'Setsuna Core JP-EN'
    END,
    'frequency', frequency_rank
)
FROM ranked_entries
WHERE entry_rank <= CASE WHEN dict_name = 'JMdict (Russian)' THEN 2 ELSE 1 END
ORDER BY frequency_rank, dict_name, term;
.quit
"@

    $sql | & $sqlite.Source $SourceDb
    if ($LASTEXITCODE -ne 0) {
        throw "sqlite3 failed with exit code $LASTEXITCODE"
    }
    if (-not (Test-Path -LiteralPath $jsonlPath) -or (Get-Item -LiteralPath $jsonlPath).Length -eq 0) {
        throw 'The generated dictionary data is empty.'
    }

    if (Test-Path -LiteralPath $OutputZip) {
        Remove-Item -LiteralPath $OutputZip -Force
    }
    Compress-Archive -LiteralPath $jsonlPath -DestinationPath $OutputZip -CompressionLevel Optimal

    $lineCount = (Get-Content -LiteralPath $jsonlPath -ReadCount 1000 | ForEach-Object { $_.Count } | Measure-Object -Sum).Sum
    $zipInfo = Get-Item -LiteralPath $OutputZip
    Write-Output ("Generated {0} entries: {1} ({2:N1} MB)" -f $lineCount, $zipInfo.FullName, ($zipInfo.Length / 1MB))
}
finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}
