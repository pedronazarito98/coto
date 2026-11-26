import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')

const TARGET_TRIPLE = 'arm64-apple-macosx26.0'

/** Builds an Apple Silicon Swift CLI helper from native/<nativeDir>/main.swift targeting macOS 26.0. */
export function buildSwiftCliHelper({ nativeDir, executable, argv }) {
  if (process.platform !== 'darwin') {
    return
  }
  const sourcePath = path.join(repoRoot, 'native', nativeDir, 'main.swift')
  const outputPath =
    readArg(argv, '--output') ??
    path.join(repoRoot, 'native', nativeDir, '.build', 'release', executable)
  const workDir = mkdtempSync(path.join(tmpdir(), `${executable}-`))
  try {
    const builtBinary = path.join(workDir, `${executable}-${TARGET_TRIPLE}`)
    execFileSync('swiftc', ['-O', sourcePath, '-target', TARGET_TRIPLE, '-o', builtBinary], {
      stdio: 'inherit'
    })
    mkdirSync(path.dirname(outputPath), { recursive: true })
    execFileSync('cp', [builtBinary, outputPath])
    chmodSync(outputPath, 0o755)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

const DEV_SWIFT_CLI_HELPERS = [
  [
    'keyboard-layout-macos',
    'orca-keyboard-layout',
    'shifted Option composition stays conservative'
  ],
  ['process-footprint-macos', 'orca-process-footprint', 'memory panel falls back to top']
]

/** Dev bundles build each helper for the host arch; a missing swiftc only degrades that helper's feature. */
export function buildDevSwiftCliHelpers(macOsDir) {
  for (const [nativeDir, executable, fallback] of DEV_SWIFT_CLI_HELPERS) {
    try {
      buildSwiftCliHelper({
        nativeDir,
        executable,
        argv: ['--single-arch', '--output', path.join(macOsDir, executable)]
      })
    } catch (error) {
      console.warn(
        `[orca-dev] ${executable} helper build failed (${fallback}): ${error?.message ?? error}`
      )
    }
  }
}

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}
