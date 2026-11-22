import type { ChildProcess } from "node:child_process";

export interface SliceTarget {
  /** npm target name, e.g. "linux-x64-gnu". */
  target: string;
  /** Value of `process.platform`. */
  os: string;
  /** Value of `process.arch`. */
  cpu: string;
  /** "glibc" or "musl" for Linux targets. */
  libc?: string;
  /** Platform package name, e.g. "@slicevm/cli-linux-x64-gnu". */
  packageName: string;
  /** "slice" or "slice.exe". */
  binaryFile: string;
}

/**
 * Absolute path of the native `slice` binary for this host.
 * Honors `SLICE_BINARY_PATH`. Throws with a descriptive message when unavailable.
 */
export function binaryPath(): string;

/** Spawns the binary with inherited stdio and mirrors its exit code and signals. */
export function runBinary(args: string[], options?: { env?: NodeJS.ProcessEnv }): ChildProcess;

/** All platforms with a prebuilt binary package. */
export function supportedTargets(): SliceTarget[];

/** The platform entry matching this host, if any. */
export function currentTarget(): SliceTarget | undefined;

/** "glibc" or "musl" on Linux, null elsewhere. */
export function detectLibc(): "glibc" | "musl" | null;
