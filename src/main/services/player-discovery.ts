import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ExternalPlayerOption, KnownExternalPlayerId } from "../../shared/domain";

interface KnownPlayerDefinition {
  id: Exclude<KnownExternalPlayerId, "SYSTEM_DEFAULT">;
  label: string;
  executableNames: string[];
  registryNames: string[];
  relativeCandidates: Array<["PROGRAM_FILES" | "PROGRAM_FILES_X86", string]>;
}

const DEFINITIONS: KnownPlayerDefinition[] = [
  {
    id: "VLC",
    label: "VLC media player",
    executableNames: ["vlc.exe"],
    registryNames: ["vlc.exe"],
    relativeCandidates: [
      ["PROGRAM_FILES", "VideoLAN\\VLC\\vlc.exe"],
      ["PROGRAM_FILES_X86", "VideoLAN\\VLC\\vlc.exe"],
    ],
  },
  {
    id: "WINDOWS_MEDIA_PLAYER",
    label: "Windows Media Player",
    executableNames: ["wmplayer.exe"],
    registryNames: ["wmplayer.exe"],
    relativeCandidates: [
      ["PROGRAM_FILES", "Windows Media Player\\wmplayer.exe"],
      ["PROGRAM_FILES_X86", "Windows Media Player\\wmplayer.exe"],
    ],
  },
  {
    id: "MPC_HC",
    label: "MPC-HC",
    executableNames: ["mpc-hc64.exe", "mpc-hc.exe"],
    registryNames: ["mpc-hc64.exe", "mpc-hc.exe"],
    relativeCandidates: [
      ["PROGRAM_FILES", "MPC-HC\\mpc-hc64.exe"],
      ["PROGRAM_FILES_X86", "MPC-HC\\mpc-hc.exe"],
      ["PROGRAM_FILES_X86", "K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe"],
      ["PROGRAM_FILES", "K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe"],
    ],
  },
];

async function isExecutableFile(filePath: string): Promise<boolean> {
  if (path.extname(filePath).toLowerCase() !== ".exe") return false;
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function run(executable: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(executable, args, { windowsHide: true, encoding: "utf8", timeout: 2500 }, (error, stdout) => {
      resolve(error ? "" : stdout);
    });
  });
}

function registryPathFromOutput(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.match(/REG_SZ\s+(.+\.exe)\s*$/i)?.[1]?.trim())
    .find(Boolean);
}

async function discoverDefinition(definition: KnownPlayerDefinition): Promise<string | undefined> {
  const candidates = new Set<string>();
  for (const executableName of definition.executableNames) {
    const output = await run("where.exe", [executableName]);
    for (const result of output
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean))
      candidates.add(result);
  }
  for (const registryName of definition.registryNames) {
    for (const root of ["HKCU", "HKLM"]) {
      for (const view of ["/reg:64", "/reg:32"]) {
        const output = await run("reg.exe", [
          "query",
          `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${registryName}`,
          "/ve",
          view,
        ]);
        const found = registryPathFromOutput(output);
        if (found) candidates.add(found);
      }
    }
  }
  const roots = {
    PROGRAM_FILES: process.env.ProgramFiles,
    PROGRAM_FILES_X86: process.env["ProgramFiles(x86)"],
  };
  for (const [rootKey, relative] of definition.relativeCandidates) {
    const root = roots[rootKey];
    if (root) candidates.add(path.join(root, relative));
  }
  for (const candidate of candidates) {
    if (await isExecutableFile(candidate)) return path.resolve(candidate);
  }
  return undefined;
}

export async function discoverKnownPlayers(): Promise<ExternalPlayerOption[]> {
  const discovered = await Promise.all(
    DEFINITIONS.map(async (definition): Promise<ExternalPlayerOption> => {
      const executablePath = process.platform === "win32" ? await discoverDefinition(definition) : undefined;
      return {
        id: definition.id,
        label: definition.label,
        kind: "KNOWN",
        available: Boolean(executablePath),
        executablePath,
        detail: executablePath ? "已偵測安裝位置" : "目前未偵測到安裝位置；開啟時將安全降級",
      };
    }),
  );
  return [
    {
      id: "SYSTEM_DEFAULT",
      label: "Windows 系統預設播放器",
      kind: "SYSTEM",
      available: true,
      detail: "交由目前的 Windows 檔案關聯開啟",
    },
    ...discovered,
  ];
}

export { isExecutableFile };
