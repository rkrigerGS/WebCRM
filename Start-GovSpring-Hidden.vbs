' ============================================================
'  GovSpring Prospecting - silent startup launcher.
'  Runs the server in the background with no visible window.
'  Put a shortcut to this file in the Windows Startup folder so
'  the app is always running after the machine boots.
' ============================================================

Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Folder this script lives in
here = fso.GetParentFolderName(WScript.ScriptFullName)

' Run "node server\server.js" from that folder, hidden (0), don't wait (False)
shell.CurrentDirectory = here
shell.Run "node server\server.js", 0, False
