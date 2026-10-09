# A real drag of files from another window into the app (Windows, #79): a small form of its
# own starts an OLE drag with the files (CF_HDROP, as Explorer does), and the mouse carries it
# over the app window and lets go there, so the system's drop reaches WebView2 and wry.
# Coordinates are physical pixels of the app's client area. Run with Windows PowerShell 5.1.
#
#   powershell -File native-drop.ps1 -List files.txt -HoverX 400 -HoverY 300 -ToX 500 -ToY 400
param(
  # A UTF-8 file with a path per line: Cyrillic does not survive the command line of Windows PowerShell.
  [Parameter(Mandatory)] [string] $List,
  [Parameter(Mandatory)] [int] $HoverX,
  [Parameter(Mandatory)] [int] $HoverY,
  [Parameter(Mandatory)] [int] $ToX,
  [Parameter(Mandatory)] [int] $ToY,
  [string] $Process = 'depesha',
  # The title of the window to drop on, for a window that is not the main one.
  [string] $Title = '',
  # Where the form of the drag sits on the screen: below the app window.
  [int] $FormX = 20,
  [int] $FormY = 660
)

$Files = [string[]] (Get-Content -LiteralPath $List -Encoding UTF8 | Where-Object { $_ })
$app = Get-Process $Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $app) { Write-Error "no window of $Process"; exit 2 }

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class NativeDrop
{
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, System.Text.StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    delegate bool EnumProc(IntPtr hwnd, IntPtr param);

    // The visible top-level window of the process with this title; zero if there is none.
    public static IntPtr Find(int pid, string title)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr p)
        {
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            System.Text.StringBuilder text = new System.Text.StringBuilder(256);
            GetWindowText(hwnd, text, 256);
            if (owner == pid && IsWindowVisible(hwnd) && text.ToString() == title) found = hwnd;
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static void Move(int fromX, int fromY, int toX, int toY)
    {
        for (int i = 1; i <= 25; i++)
        {
            SetCursorPos(fromX + (toX - fromX) * i / 25, fromY + (toY - fromY) * i / 25);
            Thread.Sleep(20);
        }
    }

    // The effect the app answered the drag with (0 = refused), or -1 if the drag never started.
    public static int Run(IntPtr app, string[] files, int hoverX, int hoverY, int toX, int toY, int formX, int formY)
    {
        SetProcessDPIAware();
        POINT origin = new POINT();
        ClientToScreen(app, ref origin);
        int result = -1;
        Form form = new Form();
        form.FormBorderStyle = FormBorderStyle.None;
        form.StartPosition = FormStartPosition.Manual;
        form.TopMost = true;
        form.Location = new Point(formX, formY);
        form.Size = new Size(160, 60);
        form.BackColor = Color.DarkOrange;
        form.MouseDown += delegate
        {
            DataObject data = new DataObject(DataFormats.FileDrop, files);
            result = (int)form.DoDragDrop(data, DragDropEffects.Copy);
            form.Close();
        };
        Thread mouse = new Thread(delegate()
        {
            Thread.Sleep(800);
            int cx = formX + 80, cy = formY + 30;
            SetCursorPos(cx, cy);
            Thread.Sleep(200);
            mouse_event(2, 0, 0, 0, UIntPtr.Zero); // left down
            Thread.Sleep(300);
            Move(cx, cy, origin.X + hoverX, origin.Y + hoverY);
            Thread.Sleep(1500); // the page lays its drop zones out
            Move(origin.X + hoverX, origin.Y + hoverY, origin.X + toX, origin.Y + toY);
            Thread.Sleep(600);
            mouse_event(4, 0, 0, 0, UIntPtr.Zero); // left up
        });
        form.Shown += delegate { mouse.Start(); };
        Application.Run(form);
        return result;
    }
}
'@

$hwnd = $app.MainWindowHandle
if ($Title) {
  $hwnd = [NativeDrop]::Find($app.Id, $Title)
  if ($hwnd -eq [IntPtr]::Zero) { Write-Error "no window titled $Title"; exit 2 }
}
$effect = [NativeDrop]::Run($hwnd, $Files, $HoverX, $HoverY, $ToX, $ToY, $FormX, $FormY)
Write-Host "drag effect: $effect"
# The page tells whether it took the files; only a drag that never started fails here.
if ($effect -lt 0) { exit 3 }
