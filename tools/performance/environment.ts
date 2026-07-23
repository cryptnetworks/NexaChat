import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  arch,
  cpus,
  freemem,
  loadavg,
  platform,
  release,
  totalmem,
} from 'node:os';
import { statfs } from 'node:fs/promises';

const execute = promisify(execFile);

export interface PerformanceEnvironment {
  platform: string;
  architecture: string;
  operatingSystemRelease: string;
  nodeVersion: string;
  v8Version: string;
  cpuModel: string;
  physicalCpuCount: number;
  logicalCpuCount: number;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  loadAverage1m: number;
  loadAverage5m: number;
  loadAverage15m: number;
  filesystemTotalBytes: number;
  filesystemFreeBytes: number;
  filesystemBlockSizeBytes: number;
  filesystemType: string;
  rustVersion: string;
  cargoVersion: string;
  dockerVersion: string;
  commit: string;
  buildMode: 'development' | 'production';
}

async function command(
  file: string,
  args: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await execute(file, [...args], {
      timeout: 2_000,
      maxBuffer: 32_768,
      encoding: 'utf8',
    });
    return result.stdout.trim().split('\n')[0];
  } catch {
    return undefined;
  }
}

async function physicalCpuCount(): Promise<number> {
  if (platform() === 'darwin') {
    const value = await command('sysctl', ['-n', 'hw.physicalcpu']);
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  if (platform() === 'linux') {
    try {
      const result = await execute('lscpu', ['--parse=core,socket'], {
        timeout: 2_000,
        maxBuffer: 65_536,
        encoding: 'utf8',
      });
      const cores = new Set(
        result.stdout
          .split('\n')
          .filter((line) => line && !line.startsWith('#')),
      );
      if (cores.size > 0) return cores.size;
    } catch {
      // The logical count remains an explicit conservative fallback.
    }
  }
  return cpus().length;
}

export async function collectPerformanceEnvironment(
  buildMode: 'development' | 'production',
): Promise<PerformanceEnvironment> {
  const cpu = cpus()[0];
  const filesystem = await statfs(process.cwd());
  const loads = loadavg();
  return {
    platform: platform(),
    architecture: arch(),
    operatingSystemRelease: release(),
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    cpuModel: cpu?.model ?? 'unknown',
    physicalCpuCount: await physicalCpuCount(),
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    loadAverage1m: loads[0] ?? 0,
    loadAverage5m: loads[1] ?? 0,
    loadAverage15m: loads[2] ?? 0,
    filesystemTotalBytes: filesystem.blocks * filesystem.bsize,
    filesystemFreeBytes: filesystem.bavail * filesystem.bsize,
    filesystemBlockSizeBytes: filesystem.bsize,
    filesystemType: `0x${filesystem.type.toString(16)}`,
    rustVersion: (await command('rustc', ['--version'])) ?? 'unavailable',
    cargoVersion: (await command('cargo', ['--version'])) ?? 'unavailable',
    dockerVersion:
      (await command('docker', [
        'version',
        '--format',
        '{{.Client.Version}}',
      ])) ?? 'unavailable',
    commit:
      (await command('git', ['rev-parse', '--verify', 'HEAD'])) ?? 'unknown',
    buildMode,
  };
}

export function comparableEnvironmentKey(
  environment: PerformanceEnvironment,
): string {
  return [
    environment.platform,
    environment.architecture,
    environment.operatingSystemRelease,
    environment.nodeVersion,
    environment.cpuModel,
    String(environment.physicalCpuCount),
    String(environment.logicalCpuCount),
    String(environment.totalMemoryBytes),
    environment.buildMode,
  ].join('|');
}
