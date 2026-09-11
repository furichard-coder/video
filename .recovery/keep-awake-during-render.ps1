$signature = @'
using System;
using System.Runtime.InteropServices;

public static class RenderPowerState
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint executionState);
}
'@

Add-Type -TypeDefinition $signature

$continuous = [uint32]0x80000000
$systemRequired = [uint32]0x00000001

[void][RenderPowerState]::SetThreadExecutionState($continuous -bor $systemRequired)

try {
    while ($true) {
        Start-Sleep -Seconds 30
    }
}
finally {
    [void][RenderPowerState]::SetThreadExecutionState($continuous)
}
