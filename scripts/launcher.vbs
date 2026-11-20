Option Explicit

Dim fso, shell, root, script, ps, command, rc
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
script = fso.BuildPath(root, "scripts\launcher.ps1")

If Not fso.FileExists(script) Then
  MsgBox "VeilLink launcher files are missing." & vbCrLf & vbCrLf & script, 16, "VeilLink"
  WScript.Quit 1
End If

ps = shell.ExpandEnvironmentStrings("%ProgramFiles%\PowerShell\7\pwsh.exe")
If Not fso.FileExists(ps) Then
  ps = shell.ExpandEnvironmentStrings("%LocalAppData%\Microsoft\WindowsApps\pwsh.exe")
End If
If Not fso.FileExists(ps) Then
  ps = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
End If

command = """" & ps & """ -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & script & """"

On Error Resume Next
rc = shell.Run(command, 0, False)
If Err.Number <> 0 Then
  MsgBox "Unable to start VeilLink: " & Err.Description, 16, "VeilLink"
  WScript.Quit 1
End If
On Error GoTo 0
