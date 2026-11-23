; Tauri NSIS installer hooks (bundle > windows > nsis > installerHooks).
;
; Virtual AutoFisher 1.x was an Electron app (electron-builder, per-user). 2.0 installs elsewhere
; under another uninstall key, so without this the two would sit side by side. Before installing,
; silently run the 1.x uninstaller. It keeps %APPDATA%\virtual-autofisher, which 2.0 reuses.
; The key name is electron-builder's GUID for appId com.r3con.virtualautofisher (stable across 1.x).

!define VAF1_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\83fb9927-1975-5190-8eef-16cbb138794b"

!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  ReadRegStr $R0 HKCU "${VAF1_UNINSTALL_KEY}" "QuietUninstallString"
  ${If} $R0 != ""
    DetailPrint "Removing Virtual AutoFisher 1.x (Electron)..."
    ExecWait $R0
    ; the NSIS uninstaller may hand over to a copy of itself: wait until its key is gone (30 s max)
    StrCpy $R1 0
    ${Do}
      ReadRegStr $R0 HKCU "${VAF1_UNINSTALL_KEY}" "QuietUninstallString"
      ${If} $R0 == ""
      ${OrIf} $R1 >= 60
        ${ExitDo}
      ${EndIf}
      Sleep 500
      IntOp $R1 $R1 + 1
    ${Loop}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend
