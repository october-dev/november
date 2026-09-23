import { createRequire } from "node:module";
import { listSimulatedDevices } from "@november/adapters";

const require = createRequire(import.meta.url);

interface PackageInfo {
  readonly name: string;
  readonly version: string;
}

function readPackageVersions(): readonly PackageInfo[] {
  const infos: PackageInfo[] = [];
  for (const id of ["@november/cli", "@november/core", "@november/adapters"]) {
    // Works from src/ during tests and from dist/ in the built artifact:
    // both sit one level below the package root.
    const pkg = require(`${id}/package.json`) as {
      name: string;
      version: string;
    };
    infos.push({ name: pkg.name, version: pkg.version });
  }
  return infos;
}

const HELP = `november — development CLI (issue #21 builds the full command set)

Usage:
  november --version        Print package versions
  november doctor           Report runtime, packages, and simulated devices
  november --help           Show this help
`;

export interface RunResult {
  readonly exitCode: number;
  readonly output: string;
}

export function run(args: readonly string[]): RunResult {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { exitCode: args.length === 0 ? 1 : 0, output: HELP };
  }
  if (args[0] === "--version" || args[0] === "-V") {
    const lines = readPackageVersions().map(
      (pkg) => `${pkg.name} ${pkg.version}`,
    );
    return { exitCode: 0, output: lines.join("\n") + "\n" };
  }
  if (args[0] === "doctor") {
    const lines: string[] = [];
    lines.push(`node ${process.version} (${process.platform}/${process.arch})`);
    for (const pkg of readPackageVersions()) {
      lines.push(`${pkg.name} ${pkg.version}`);
    }
    lines.push("");
    lines.push("Simulated devices (no hardware required):");
    for (const device of listSimulatedDevices()) {
      lines.push(`  ${device.id}  ${device.description}`);
    }
    return { exitCode: 0, output: lines.join("\n") + "\n" };
  }
  return {
    exitCode: 1,
    output: `november: unknown command: ${args[0]}\n\n${HELP}`,
  };
}
