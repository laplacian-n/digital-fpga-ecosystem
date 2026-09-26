; installer.iss - Inno Setup 6 script for FPGA Ecosystem.
; Built by launcher\build_windows.ps1 (passes AppVersion / SourceDir).
;
; Per-user install (no admin prompt) into %LOCALAPPDATA%\Programs\FPGA Ecosystem,
; so FPGA Builder can write its config/build folders next to the exe.
; The "features" page only seeds the first config.json; everything can be
; changed later in the app (หน้า ตั้งค่า).

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef SourceDir
  #define SourceDir "..\dist\FPGAEcosystem"
#endif

[Setup]
AppId={{05762AF4-D6BA-470D-8AE8-EB7637C72B05}
AppName=FPGA Ecosystem
AppVersion={#AppVersion}
AppPublisher=Digital FPGA Ecosystem
DefaultDirName={localappdata}\Programs\FPGA Ecosystem
DefaultGroupName=FPGA Ecosystem
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=FPGAEcosystem-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\FPGAEcosystem.exe
SetupIconFile=icon.ico
CloseApplications=yes

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "feat_ai";     Description: "AI chat in Schematic Studio (works offline for equations / truth tables)"; GroupDescription: "Features (can be changed later in Settings):"
Name: "feat_sim";    Description: "Backend simulation (Python netlist sim)"; GroupDescription: "Features (can be changed later in Settings):"
Name: "feat_fpga";   Description: "FPGA Builder - build .bit and program the board (needs Vivado installed separately)"; GroupDescription: "Features (can be changed later in Settings):"
Name: "feat_cosim";  Description: "GHDL co-simulation check (needs GHDL)"; GroupDescription: "Features (can be changed later in Settings):"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\FPGA Ecosystem"; Filename: "{app}\FPGAEcosystem.exe"
Name: "{group}\Uninstall FPGA Ecosystem"; Filename: "{uninstallexe}"
Name: "{userdesktop}\FPGA Ecosystem"; Filename: "{app}\FPGAEcosystem.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\FPGAEcosystem.exe"; Description: "Start FPGA Ecosystem"; Flags: nowait postinstall skipifsilent
; silent in-place update started by the app itself: start the new version afterwards
Filename: "{app}\FPGAEcosystem.exe"; Parameters: "--after-update"; Flags: nowait; Check: WizardSilent

[Code]
function B(const Task: String): String;
begin
  if WizardIsTaskSelected(Task) then Result := 'true' else Result := 'false';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Dir, F, Json: String;
begin
  if CurStep <> ssPostInstall then Exit;
  Dir := ExpandConstant('{userappdata}\FPGA Ecosystem');
  F := Dir + '\config.json';
  if FileExists(F) then Exit;          { keep an existing user's settings on upgrade }
  ForceDirectories(Dir);
  Json := '{' + #13#10 +
    '  "features": {' + #13#10 +
    '    "ai": ' + B('feat_ai') + ',' + #13#10 +
    '    "sim": ' + B('feat_sim') + ',' + #13#10 +
    '    "fpga": ' + B('feat_fpga') + ',' + #13#10 +
    '    "cosim": ' + B('feat_cosim') + #13#10 +
    '  }' + #13#10 + '}' + #13#10;
  SaveStringToFile(F, Json, False);
end;
