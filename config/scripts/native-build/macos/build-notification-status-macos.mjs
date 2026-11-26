#!/usr/bin/env node
// Embed target CFBundleIdentifier in __TEXT,__info_plist so later release/ad-hoc codesign preserves the identifier macOS uses for notification records (native/notification-status-macos/main.swift).
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const sourcePath = path.join(repoRoot, 'native', 'notification-status-macos', 'main.swift')
const defaultOutputPath = path.join(
  repoRoot,
  'native',
  'notification-status-macos',
  '.build',
  'release',
  'orca-notification-status'
)

if (process.platform !== 'darwin') {
  process.exit(0)
}

const args = process.argv.slice(2)
const bundleId = readArg('--bundle-id') ?? 'com.coto.app'
const outputPath = readArg('--output') ?? defaultOutputPath
// Apple Silicon only; Coto requires macOS 26.0+ on arm64.
const TARGET_TRIPLE = 'arm64-apple-macosx26.0'

const workDir = path.join(tmpdir(), `orca-notification-status-${process.pid}`)
mkdirSync(workDir, { recursive: true })
try {
  const plistPath = path.join(workDir, 'Info.plist')
  writeFileSync(plistPath, embeddedInfoPlist(bundleId), 'utf8')
  const builtBinary = path.join(workDir, `orca-notification-status-${TARGET_TRIPLE}`)
  execFileSync(
    'swiftc',
    [
      '-O',
      sourcePath,
      '-target',
      TARGET_TRIPLE,
      '-o',
      builtBinary,
      '-Xlinker',
      '-sectcreate',
      '-Xlinker',
      '__TEXT',
      '-Xlinker',
      '__info_plist',
      '-Xlinker',
      plistPath
    ],
    { stdio: 'inherit' }
  )
  mkdirSync(path.dirname(outputPath), { recursive: true })
  execFileSync('cp', [builtBinary, outputPath])
  execFileSync('chmod', ['755', outputPath])
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function readArg(name) {
  const index = args.indexOf(name)
  return index !== -1 ? args[index + 1] : undefined
}

function embeddedInfoPlist(identifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${identifier}</string>
  <key>CFBundleName</key>
  <string>orca-notification-status</string>
</dict>
</plist>
`
}
