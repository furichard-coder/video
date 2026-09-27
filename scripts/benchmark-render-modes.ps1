param(
  [ValidateRange(3, 60)]
  [int]$ClipSeconds = 60
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (Get-Process ffmpeg -ErrorAction SilentlyContinue) {
  throw "Existing ffmpeg process detected; benchmark aborted without starting work."
}

$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
$manifestPath = (
  Get-ChildItem -LiteralPath $env:APPDATA -Recurse -File -Filter "project.source-manifest.json" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
).FullName
if (-not $manifestPath) { throw "Active project manifest was not found." }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$sources = @(
  $manifest.sources |
    Where-Object {
      $_.kind -eq "VIDEO" -and
      $_.mediaInfo.width -ge 3840 -and
      $_.mediaInfo.videoCodec -match "h264|hevc|h265" -and
      (Test-Path -LiteralPath $_.sourcePath)
    } |
    Select-Object -First 4
)
if ($sources.Count -lt 4) { throw "Need four existing 4K H.264/HEVC project sources." }

$benchmarkRoot = Join-Path ([IO.Path]::GetTempPath()) ("SceneryWalker-v067-benchmark-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $benchmarkRoot | Out-Null

function Quote-Arg([string]$value) {
  if ($value -notmatch '[\s"]') { return $value }
  return '"' + $value.Replace('"', '\"') + '"'
}

function Mean($values) {
  $numbers = @($values | Where-Object { $_ -ne $null })
  if (-not $numbers.Count) { return $null }
  return [math]::Round((($numbers | Measure-Object -Average).Average), 2)
}

function Test-Encoder([string]$encoder) {
  & $ffmpeg -hide_banner -loglevel error -f lavfi -i "color=s=320x180:d=0.3" -frames:v 4 -an -pix_fmt nv12 -c:v $encoder -f null NUL 2>$null
  return $LASTEXITCODE -eq 0
}

$h264Encoder = if (Test-Encoder "h264_nvenc") { "h264_nvenc" } elseif (Test-Encoder "h264_qsv") { "h264_qsv" } else { "libx264" }
$h265Encoder = if (Test-Encoder "hevc_nvenc") { "hevc_nvenc" } elseif (Test-Encoder "hevc_qsv") { "hevc_qsv" } else { "libx265" }
$hardwareDecoder = if ($h264Encoder -eq "h264_nvenc") { "cuda" } elseif ($h264Encoder -eq "h264_qsv") { "qsv" } else { "cpu" }

function Start-BenchmarkProcess($modeName, [int]$jobIndex, [string]$decoder, [string]$encoder) {
  $left = $sources[$jobIndex % $sources.Count].sourcePath
  $right = $sources[($jobIndex + 1) % $sources.Count].sourcePath
  $progressPath = Join-Path $benchmarkRoot ("{0}-{1}.progress.txt" -f $modeName, $jobIndex)
  $errorPath = Join-Path $benchmarkRoot ("{0}-{1}.error.txt" -f $modeName, $jobIndex)
  $outputPath = Join-Path $benchmarkRoot ("{0}-{1}.mp4" -f $modeName, $jobIndex)
  $inputPrefix = if ($decoder -ne "cpu") { @("-hwaccel", $decoder, "-hwaccel_output_format", $decoder) } else { @() }
  $video0 = if ($decoder -ne "cpu") { "[0:v]hwdownload,format=nv12," } else { "[0:v]" }
  $video1 = if ($decoder -ne "cpu") { "[1:v]hwdownload,format=nv12," } else { "[1:v]" }
  $filter = "${video0}fps=30000/1001,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v0];${video1}fps=30000/1001,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,settb=AVTB,setpts=PTS-STARTPTS[v1];[v0][v1]xfade=transition=fade:duration=0.3:offset=$([math]::Max(0.3, $ClipSeconds - 0.3))[vout]"
  $ffmpegArgs = @("-hide_banner", "-loglevel", "error", "-y")
  $ffmpegArgs += $inputPrefix
  $ffmpegArgs += @("-ss", "0", "-t", "$ClipSeconds", "-i", $left)
  $ffmpegArgs += $inputPrefix
  $ffmpegArgs += @("-ss", "0", "-t", "$ClipSeconds", "-i", $right)
  $codecArgs = switch ($encoder) {
    "h264_nvenc" { @("-c:v", $encoder, "-preset", "p4", "-rc", "vbr", "-cq", "18", "-b:v", "0") }
    "hevc_nvenc" { @("-c:v", $encoder, "-preset", "p4", "-rc", "vbr", "-cq", "20", "-b:v", "0") }
    "h264_qsv" { @("-c:v", $encoder, "-preset", "medium", "-global_quality", "18") }
    "hevc_qsv" { @("-c:v", $encoder, "-preset", "medium", "-global_quality", "20") }
    "libx265" { @("-c:v", $encoder, "-preset", "medium", "-crf", "24") }
    default { @("-c:v", "libx264", "-preset", "medium", "-crf", "20") }
  }
  $ffmpegArgs += @(
    "-filter_complex_threads", "2", "-filter_complex", $filter,
    "-map", "[vout]", "-an"
  )
  $ffmpegArgs += $codecArgs
  $ffmpegArgs += @("-pix_fmt", "yuv420p", "-r", "30000/1001", "-progress", $progressPath, "-nostats", $outputPath)
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $ffmpeg
  $startInfo.Arguments = ($ffmpegArgs | ForEach-Object { Quote-Arg $_ }) -join " "
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  if (-not $process.Start()) { throw "Could not start benchmark FFmpeg." }
  return [pscustomobject]@{ Process = $process; ErrorPath = $errorPath; ProgressPath = $progressPath; OutputPath = $outputPath }
}

function Invoke-Mode($name, [int]$parallelJobs, [string]$decoder, [string]$encoder) {
  $cpuSamples = [Collections.Generic.List[double]]::new()
  $gpuSamples = [Collections.Generic.List[double]]::new()
  $gpuEncodeSamples = [Collections.Generic.List[double]]::new()
  $gpuDecodeSamples = [Collections.Generic.List[double]]::new()
  $gpuComputeSamples = [Collections.Generic.List[double]]::new()
  $diskSamples = [Collections.Generic.List[double]]::new()
  $ramPeak = 0.0
  $vramPeak = 0.0
  $temporaryPeak = 0.0
  $failed = $false
  $failure = ""
  $started = [Diagnostics.Stopwatch]::StartNew()
  for ($cursor = 0; $cursor -lt 4; $cursor += $parallelJobs) {
    $waveCount = [math]::Min($parallelJobs, 4 - $cursor)
    $jobs = @(0..($waveCount - 1) | ForEach-Object { Start-BenchmarkProcess $name ($cursor + $_) $decoder $encoder })
    while (@($jobs | Where-Object { -not $_.Process.HasExited }).Count) {
      Start-Sleep -Milliseconds 750
      $waveRam = 0.0
      foreach ($job in $jobs) {
        if (-not $job.Process.HasExited) {
          $job.Process.Refresh()
          $waveRam += $job.Process.PrivateMemorySize64
        }
      }
      $ramPeak = [math]::Max($ramPeak, $waveRam)
      $cpu = Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'" -ErrorAction SilentlyContinue
      $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -ErrorAction SilentlyContinue
      $gpu = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue)
      $gpuMemory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue)
      $vramPeak = [math]::Max($vramPeak, [double](($gpuMemory | Measure-Object DedicatedUsage -Sum).Sum))
      $temporaryPeak = [math]::Max($temporaryPeak, [double](Get-ChildItem -LiteralPath $benchmarkRoot -Filter "$name-*" -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)
      if ($cpu) { $cpuSamples.Add([double]$cpu.PercentProcessorTime) }
      if ($disk) { $diskSamples.Add([double]$disk.DiskReadBytesPersec + [double]$disk.DiskWriteBytesPersec) }
      if ($gpu.Count) {
        $enc = [math]::Min(100, [double](($gpu | Where-Object Name -match 'engtype_VideoEncode' | Measure-Object UtilizationPercentage -Sum).Sum))
        $dec = [math]::Min(100, [double](($gpu | Where-Object Name -match 'engtype_VideoDecode' | Measure-Object UtilizationPercentage -Sum).Sum))
        $threeD = [math]::Min(100, [double](($gpu | Where-Object Name -match 'engtype_3D' | Measure-Object UtilizationPercentage -Sum).Sum))
        $compute = [math]::Min(100, [double](($gpu | Where-Object Name -match 'engtype_(Compute|CUDA)' | Measure-Object UtilizationPercentage -Sum).Sum))
        $gpuEncodeSamples.Add($enc)
        $gpuDecodeSamples.Add($dec)
        $gpuComputeSamples.Add($compute)
        $gpuSamples.Add([math]::Max($compute, [math]::Max($threeD, [math]::Max($enc, $dec))))
      }
    }
    foreach ($job in $jobs) {
      $stderr = $job.Process.StandardError.ReadToEnd()
      $job.Process.WaitForExit()
      if ($job.Process.ExitCode -ne 0) {
        $failed = $true
        $failure = ($stderr -split "`r?`n" | Select-Object -Last 5) -join " "
      }
      $job.Process.Dispose()
    }
    if ($failed) { break }
  }
  $started.Stop()
  $outputDurationSeconds = 4 * ($ClipSeconds * 2 - 0.3)
  [pscustomobject]@{
    mode = $name
    jobs = $parallelJobs
    decoder = $decoder
    encoder = $encoder
    fps = if ($failed) { $null } else { [math]::Round(($outputDurationSeconds * 30000 / 1001) / $started.Elapsed.TotalSeconds, 2) }
    speed = if ($failed) { $null } else { [math]::Round($outputDurationSeconds / $started.Elapsed.TotalSeconds, 3) }
    cpuPercent = Mean $cpuSamples
    gpuPercent = Mean $gpuSamples
    gpuEncodePercent = Mean $gpuEncodeSamples
    gpuDecodePercent = Mean $gpuDecodeSamples
    gpuComputePercent = Mean $gpuComputeSamples
    ramPeakBytes = [math]::Round($ramPeak)
    vramPeakBytes = [math]::Round($vramPeak)
    ssdTemporaryPeakBytes = [math]::Round($temporaryPeak)
    finalFileSizeBytes = [math]::Round([double](Get-ChildItem -LiteralPath $benchmarkRoot -Filter "$name-*.mp4" -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum)
    ssdBytesPerSecond = Mean $diskSamples
    processingSeconds = [math]::Round($started.Elapsed.TotalSeconds, 3)
    status = if ($failed) { "FAILED_SAFE" } else { "PASS" }
    failure = if ($failed) { $failure } else { $null }
  }
}

try {
  $results = @(
    Invoke-Mode "ORIGINAL_NORMAL_2" 2 "cpu" "h264_qsv"
    Invoke-Mode "NORMAL_2" 2 "cpu" $h264Encoder
    Invoke-Mode "NORMAL_3" 3 "cpu" $h264Encoder
    Invoke-Mode "NORMAL_4" 4 "cpu" $h264Encoder
    Invoke-Mode "HIGH_SPEED_H264" 3 $hardwareDecoder $h264Encoder
    Invoke-Mode "H265" 2 "cpu" $h265Encoder
  )
  $fingerprintSource = (& $ffmpeg -version | Select-Object -First 1) + "|" + ((Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + ":" + $_.DriverVersion }) -join "|")
  $fingerprint = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($fingerprintSource)))
  $fastest = @($results | Where-Object status -eq "PASS" | Sort-Object processingSeconds | Select-Object -First 1)[0]
  [pscustomobject]@{
    schemaVersion = 1
    fingerprint = $fingerprint
    capturedAt = (Get-Date).ToString("o")
    project = $manifest.name
    sources = @($sources | ForEach-Object { $_.sourcePath })
    clipSeconds = $ClipSeconds
    recommendedMode = if ($fastest.mode -eq "HIGH_SPEED_H264") { "HIGH_SPEED" } else { "NORMAL" }
    recommendedVideoCodec = if ($h264Encoder -eq "h264_nvenc") { "H264_NVENC" } elseif ($h264Encoder -eq "h264_qsv") { "H264_QSV" } else { "H264" }
    recommendedParallelJobs = $fastest.jobs
    note = "Isolated read-only source benchmark. Every row performs early 1080p normalization and xfade. Hardware choices were accepted only after a real encoder startup probe."
    results = $results
  } | ConvertTo-Json -Depth 6
} finally {
  $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $resolvedBenchmark = [IO.Path]::GetFullPath($benchmarkRoot)
  if ($resolvedBenchmark.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedBenchmark)) {
    Remove-Item -LiteralPath $resolvedBenchmark -Recurse -Force
  }
}
