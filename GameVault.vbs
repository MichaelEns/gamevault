' GameVault launcher.
'
' Started by the desktop / Start Menu shortcut. Three jobs:
'   1. if GameVault is already running, just open the browser (do not start
'      a second copy fighting for the port)
'   2. otherwise start node with NO console window
'   3. wait until the server is actually answering, then open the browser
'
' Run via wscript.exe so nothing flashes on screen.

Option Explicit

Dim fso, shell, http, root, port, url, i, running

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

root = fso.GetParentFolderName(WScript.ScriptFullName)
port = 8787

' Honour a PORT override in .env so the launcher and the server agree.
Dim envPath, line, stream
envPath = fso.BuildPath(root, ".env")
If fso.FileExists(envPath) Then
  Set stream = fso.OpenTextFile(envPath, 1)
  Do Until stream.AtEndOfStream
    line = Trim(stream.ReadLine)
    If Left(line, 5) = "PORT=" Then
      If IsNumeric(Mid(line, 6)) Then port = CInt(Mid(line, 6))
    End If
  Loop
  stream.Close
End If

url = "http://localhost:" & port & "/"

' --- already running? -------------------------------------------------------
running = False
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
http.setTimeouts 1000, 1000, 2000, 2000
http.open "GET", url & "api/health", False
http.send
If Err.Number = 0 And http.status = 200 Then running = True
Err.Clear
On Error GoTo 0

If running Then
  shell.Run url, 1, False
  WScript.Quit 0
End If

' --- start it ---------------------------------------------------------------
' 0 = hidden window. The server keeps running after this script exits.
shell.CurrentDirectory = root
shell.Run "cmd /c node """ & fso.BuildPath(root, "server.mjs") & """", 0, False

' --- wait for readiness, then open the browser -------------------------------
' Polling beats a fixed sleep: a cold start is usually under a second, but a
' first run that has to read a large library can take several.
For i = 1 To 40
  WScript.Sleep 250
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 2000, 2000
  http.open "GET", url & "api/health", False
  http.send
  If Err.Number = 0 And http.status = 200 Then
    Err.Clear
    On Error GoTo 0
    shell.Run url, 1, False
    WScript.Quit 0
  End If
  Err.Clear
  On Error GoTo 0
Next

' Never came up. Show the reason rather than failing silently.
MsgBox "GameVault did not start." & vbCrLf & vbCrLf & _
       "Open a terminal in:" & vbCrLf & root & vbCrLf & vbCrLf & _
       "and run:  node server.mjs" & vbCrLf & _
       "to see the error.", vbExclamation, "GameVault"
