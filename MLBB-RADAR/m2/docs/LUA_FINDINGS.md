# MLBB Lua AC — Sensor Inventory (carved from runtime chunks)

Source: dump_v7 session (3370 chunks, 37.6MB), string-extracted from bytecode
constant tables. Key chunks: 1541 (GameLobbyCheck master), 218/2191 (shadowapp),
parse chunks with CheckLogicSize / CheckInstallApp.

## 1. GameLobbyCheck master dispatcher (chunk 1541)

Lifecycle: StartGameLobbyCheck / GameLobbyCheck / mCloseGameLobbyCheck
(fires around entering main city). All reports ride
`Cmd_Act_SocialConfig_GetSocialGFPId_CS.sSocialName` via `OpcodeTable.FormatTableFields1/2`.

Checks found (constant table):
- APKSignature.IsSignatureSame + GetApplicationClassName vs "android.app.Application"
  -> report key: InstallMalApp-goMainCity-lua-
- DLL integrity: mAndroidDllMD5 vs md5file over persistentDataPath
  -> DllDiff-goMainCity-lua-DeleteFile   (note: DeleteFile = AC can delete patched files)
- Resource diff: -> ResDiff-goMainCity-lua-HACK_APP: / HACK_APP_3
- Mod packages: mod.eap.mlmod / mlmod -> MlModHack-goMainCity-lua-HACK_APP_1:
  MlModInstall-goMainCity-lua-HACK_APP_2: / HACK_APP_FOUND
- Cheat-tool probes: catch_.me_.if_.you_.can_ / catch_.me1_.if_.you_.can_
  (obfuscated GameGuardian probes), com.lulu.lulubox ("l-u-l-u"), com.game.box / NimoBox
- Visibility hack: SetSkillInvisibility / _iSkillInvisibility
  -> "Visibility-goMainCity-lua-Kill="  (server-side kill directive format)
- Flag state machine: IsSweet / SweetKey / SetSweet / CPlusCrashKey (PlayerPrefs,
  persisted across sessions), math.floor/random involved
- Resource statistics: ReportResourceStatistic / ReportResStat ("no new c++")
- Platform gates: IsCheckAndroid / IsCheckIOS, LuaHelper.IsAndroid/IsEditor/IsVersion2017

## 2. CheckLogicSize (parse chunks, source)

/proc/self/maps -> sum of liblogic.so mapped sizes -> "lzo-<size>"
via Cmd_Team_GetSocialGFPId_CS.sSocialName. Fires from GameMainLua.OnGoMainCity
wrap (Android + IsVersion2017). -1 = maps unreadable, -2 = not android.

## 3. CheckInstallApp (parse chunks, source)

Package snitch list (DeviceUtil.IsInstallApp) -> UIFuncs.SendReport("client_AppInstall")
via FormatTableFields2. Includes com.lexa.fakegps (Fake GPS detection!), social apps
(discord/tiktok/vk...), taptap, shareit. Fires from GameEntry.OnRoleInit wrap.

## 4. shadowapp reporter (chunks 218, 2191)

Calls ACInterface.shadowapp (C# virtualization/clone-app detection) + DeviceUtil.IsInstallApp,
reports via THREE channels: Cmd_Act_SocialConfig_GetSocialGFPId_CS,
Cmd_Photo_GetSocialGFPId_CS, Cmd_Social_GetSocialGFPId_CS. Flags:
mGFPData, bReportResDiff, m_bMustSelectReportPlugIn.
Error strings: "E:sdplua.append is nil", "E:ACInterface.shadowapp is nil".

## 5. Native/C# side (previously mapped - unchanged)

ACInterface.CheckHook/metins/Estimate*/CheckNetworkInterface(VPN)/verifyso(MD5 of
lib memory)/checklib(exit 0)/PKCS7 verify. AntiCheatReporter (skill audit),
CheatAfkReporter (bot/AFK), SDKCommon/DeviceUtil root, GPSDK/ComFunc emulator.

## 6. EventPluginActivity (chunk 115) - custom room / UserDefineMatch AC

Calls ACInterface metins family: ValidateRes, ValidateLib, GetMetins/1/2/3.
Report keys: Emulator-UserDefineMatch-lua, Root-UserDefineMatch-lua,
PVP.unity3d-UserDefineMatch-lua-MD5, Logic-UserDefineMatch-lua-hook,
Timeout-UserDefineMatch-lua. Reads Room_CheatInfo_SC from server.
Server pushes check config as ServerCheckInfo {iType, iSign, sResult}
(iSign = signature -> C# PKCS7 Verify). Uses io.open/io.lines (maps reader).

## 7. PlugCheckActivity (chunk 154) - server-driven file check

Server sends PlugCheck_Role_CheckFileInfo_SC with fileCheckList {filecheck,
version}; client validates + reports via PlugCheck_Role_ReportIdInfo_SC.
Also CheckVPN / SetVPNConfig (server-pushed VPN interface config).

## Implications

- Report channel is ONE wire format: FormatTableFields1/2 + GetSocialGFPId family.
  Decode FormatTableFields and you can read/fake every AC report in transit.
- "Sweet"/"Kill" flags persist in PlayerPrefs (SweetKey, CPlusCrashKey) - check
  device prefs for these keys; a set flag may follow the account across sessions.
- DllDiff check implies client-side DLL/so diffing with server-provided MD5s
  (mAndroidDllMD5); DeleteFile = active remediation, not just reporting.
- GameGuardian probes are name-obfuscated strings - grep for "catch_.me" if hunting.
