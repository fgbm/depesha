# The screen of a Windows runner for the drop run (#79): a bigger resolution, and the system's
# own scaling (not the browser's), which the drop positions depend on. The scaling is Windows'
# internal call behind Settings > Display > Scale, one step at a time; it holds for programs
# started afterwards. Prints what it found and what it set; never fails the job.
#
#   powershell -File windows-display.ps1 -Width 1920 -Height 1080 -Percent 200
param(
  [int] $Width = 1920,
  [int] $Height = 1080,
  # The scale asked for; the highest the screen allows is taken if it allows less.
  [int] $Percent = 200
)

# The biggest the display driver takes, down from the size asked for. A mode it does not have
# is reported as set all the same, so the screen is asked what it got.
Add-Type -AssemblyName System.Windows.Forms
foreach ($mode in @(@(2560, 1440), @($Width, $Height))) {
  try { Set-DisplayResolution -Width $mode[0] -Height $mode[1] -Force -ErrorAction Stop } catch { Write-Host "resolution $($mode[0])x$($mode[1]): $_" }
  $got = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  Write-Host "asked $($mode[0])x$($mode[1]), the screen is $($got.Width)x$($got.Height)"
  if ($got.Width -eq $mode[0] -and $got.Height -eq $mode[1]) { break }
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DisplayScale
{
    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint paths, out uint modes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint paths, IntPtr pathBuf, ref uint modes, IntPtr modeBuf, IntPtr topology);
    [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(IntPtr header);
    [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(IntPtr header);

    static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

    // The percent that is in force after the call; the first screen only.
    public static string Set(int percent)
    {
        uint np, nm;
        int rc = GetDisplayConfigBufferSizes(2, out np, out nm); // QDC_ONLY_ACTIVE_PATHS
        if (rc != 0) return "GetDisplayConfigBufferSizes " + rc;
        IntPtr paths = Marshal.AllocHGlobal((int)np * 72);
        IntPtr modes = Marshal.AllocHGlobal((int)nm * 64);
        rc = QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero);
        if (rc != 0 || np == 0) return "QueryDisplayConfig " + rc;
        // The source of the first path: its adapter (8 bytes) and its id.
        long adapter = Marshal.ReadInt64(paths, 0);
        int id = Marshal.ReadInt32(paths, 8);

        IntPtr get = Marshal.AllocHGlobal(32);
        Marshal.WriteInt32(get, 0, -3);   // DISPLAYCONFIG_DEVICE_INFO_GET_DPI_SCALE
        Marshal.WriteInt32(get, 4, 32);
        Marshal.WriteInt64(get, 8, adapter);
        Marshal.WriteInt32(get, 16, id);
        rc = DisplayConfigGetDeviceInfo(get);
        if (rc != 0) return "get scale " + rc;
        int min = Marshal.ReadInt32(get, 20), cur = Marshal.ReadInt32(get, 24), max = Marshal.ReadInt32(get, 28);
        // Relative to the recommended step, which is the 0; the smallest step is the 100 %.
        int want = Array.IndexOf(Steps, percent);
        if (want < 0) want = 0;
        int rel = Math.Min(max, want + min);
        string before = Steps[cur - min] + " %, from " + Steps[0] + " to " + Steps[max - min] + " %";

        IntPtr set = Marshal.AllocHGlobal(24);
        Marshal.WriteInt32(set, 0, -4);   // DISPLAYCONFIG_DEVICE_INFO_SET_DPI_SCALE
        Marshal.WriteInt32(set, 4, 24);
        Marshal.WriteInt64(set, 8, adapter);
        Marshal.WriteInt32(set, 16, id);
        Marshal.WriteInt32(set, 20, rel);
        rc = DisplayConfigSetDeviceInfo(set);
        if (rc != 0) return "set scale " + rc + " (was " + before + ")";
        rc = DisplayConfigGetDeviceInfo(get);
        return "was " + before + ", now " + Steps[Marshal.ReadInt32(get, 24) - min] + " %";
    }
}
'@

Write-Host ("scale: " + [DisplayScale]::Set($Percent))
