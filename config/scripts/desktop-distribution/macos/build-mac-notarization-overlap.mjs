import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { darwinVersionForMacos } from '../../../../src/shared/updater/requirements/macos-darwin-floor.ts'
import { assertMacTerminalHostUuid } from '../../macos/terminal-host-bundle/macos-terminal-host-bundle.cjs'
import { readMinimumMacosVersion, withMinimumSystemVersion } from './gate-mac-update-manifests.mjs'
import { assertMacExecutableUuid } from './macos-executable-uuid.cjs'
import {
  findInstalledMacSigningIdentity,
  resolveExplicitMacSigningIdentity
} from './mac-signing-identity.cjs'

const ARM64_ARCH = 3 // electron-builder Arch.arm64
const NOTARY_TRANSIENT_ERROR_PATTERN =
  /abortedUpload|connectTimeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timedOut|502|503|504/i

async function notarizeWithRetry(notarize, options, label, log) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await notarize(options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (attempt >= 3 || !NOTARY_TRANSIENT_ERROR_PATTERN.test(message)) {
        throw error
      }
      log(
        `[mac-notary] transient upload/network failure for ${label} (attempt ${attempt}/3), retrying...`
      )
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 5000))
    }
  }
}

async function sha512Base64(filePath) {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('base64')
}

function signMacDmg(dmgPath, keychainFile) {
  const identity =
    resolveExplicitMacSigningIdentity(process.env.CSC_NAME, keychainFile) ??
    findInstalledMacSigningIdentity(keychainFile)
  if (!identity) {
    throw new Error(`Missing Developer ID signing identity for ${dmgPath}`)
  }
  const args = ['--force', '--sign', identity, '--timestamp']
  if (keychainFile) {
    args.push('--keychain', keychainFile)
  }
  args.push(dmgPath)
  execFileSync('codesign', args, { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', dmgPath], { stdio: 'inherit' })
}

function verifyDmgIntegrity(dmgPath) {
  execFileSync('codesign', ['--verify', '--strict', dmgPath], { stdio: 'inherit' })
  execFileSync('xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' })
  execFileSync('hdiutil', ['verify', dmgPath], { stdio: 'inherit' })
  execFileSync(
    'spctl',
    [
      '--assess',
      '--type',
      'open',
      '--context',
      'context:primary-signature',
      '--verbose=4',
      dmgPath
    ],
    { stdio: 'inherit' }
  )
}

function verifyZippedApp(zipPath, productFilename, verify) {
  const extractDir = mkdtempSync(join(tmpdir(), 'coto-zip-verify-'))
  try {
    execFileSync('ditto', ['-x', '-k', zipPath, extractDir], { stdio: 'inherit' })
    const extractedApp = join(extractDir, `${productFilename}.app`)
    verify(extractedApp)
    execFileSync('spctl', ['--assess', '--type', 'execute', '--verbose=4', extractedApp], {
      stdio: 'inherit'
    })
  } finally {
    rmSync(extractDir, { recursive: true, force: true })
  }
}

async function updateMacManifests({ distDir, zipName, dmgName, dmgMeta, zipMeta }) {
  const { parse, stringify } = await import('yaml')
  const darwinVersion = darwinVersionForMacos(readMinimumMacosVersion(distDir))
  const manifestPaths = readdirSync(distDir)
    .filter((name) => name.endsWith('-mac.yml'))
    .map((name) => join(distDir, name))
  if (manifestPaths.length === 0) {
    throw new Error(`No *-mac.yml manifest generated in ${distDir}`)
  }
  for (const manifestPath of manifestPaths) {
    const manifest = parse(readFileSync(manifestPath, 'utf8'))
    const files = Array.isArray(manifest.files) ? manifest.files : []
    const nextFiles = files.map((entry) => {
      if (entry.url === dmgName) {
        return { url: dmgName, sha512: dmgMeta.sha512, size: dmgMeta.size }
      }
      if (entry.url === zipName) {
        return { url: zipName, sha512: zipMeta.sha512, size: zipMeta.size }
      }
      return entry
    })
    manifest.files = nextFiles
    manifest.path = zipName
    manifest.sha512 = zipMeta.sha512
    const updated = withMinimumSystemVersion(stringify(manifest), darwinVersion)
    writeFileSync(manifestPath, updated, 'utf8')
  }
  return manifestPaths
}

async function publishFinalMacArtifacts({
  config,
  version,
  filePaths,
  GitHubPublisher,
  CancellationToken
}) {
  const publishConfig = config.publish
  if (!publishConfig || publishConfig.provider !== 'github') {
    throw new Error('macOS release publication requires a GitHub publish configuration')
  }
  const publisher = new GitHubPublisher(
    { cancellationToken: new CancellationToken(), progress: null },
    publishConfig,
    version,
    {
      publish: 'always',
      draft: publishConfig.releaseType === 'draft',
      prerelease: publishConfig.releaseType === 'prerelease'
    },
    null,
    null
  )
  for (const file of filePaths) {
    await publisher.upload({ file, arch: ARM64_ARCH })
  }
}

/**
 * Packages the Apple Silicon (arm64) release bundle, notarizes and staples Coto.app
 * before ZIP and DMG creation, signs/notarizes/staples the DMG, refreshes blockmap and
 * update manifests from the stapled artifacts, and publishes only finalized files when requested.
 */
export async function buildWithOverlappingNotarization({
  config,
  build,
  notarize,
  verify,
  targets,
  publish,
  credentials,
  buildBlockMap,
  publishFinalized,
  log = console.log
}) {
  if (!config.forceCodeSigning || !config.mac?.hardenedRuntime || config.mac.notarize !== true) {
    throw new Error('macOS release packaging requires the complete release signing policy')
  }
  for (const hook of ['afterSign', 'artifactBuildStarted', 'artifactBuildCompleted']) {
    if (config[hook] !== undefined && typeof config[hook] !== 'function') {
      throw new Error(`Unsupported ${hook} hook: expected a function`)
    }
  }
  const signedContext = {
    ready: false,
    distDir: '',
    version: '',
    productFilename: '',
    keychainFile: ''
  }
  let appNotaryPromise = null

  const waitForAppNotarization = async () => {
    if (!appNotaryPromise) {
      throw new Error('macOS arm64 app bundle was not signed before artifact packaging')
    }
    await appNotaryPromise
  }

  // Never let electron-builder upload unnotarized DMG bytes or stale manifests mid-build.
  const artifacts = await build({
    targets,
    publish: 'never',
    config: {
      ...config,
      mac: { ...config.mac, notarize: false },
      concurrency: { ...config.concurrency, jobs: 1 },
      afterSign: async (context) => {
        await config.afterSign?.(context)
        if (context.electronPlatformName !== 'darwin' || context.arch !== ARM64_ARCH) {
          throw new Error('Only Apple Silicon (arm64) macOS packaging is supported')
        }
        const productFilename = String(context.packager.appInfo.productFilename)
        const appPath = join(String(context.appOutDir), `${productFilename}.app`)
        if (appNotaryPromise) {
          throw new Error('Duplicate macOS signing invocation')
        }
        const codeSigningInfo = context.packager.codeSigningInfo?.value
          ? await context.packager.codeSigningInfo.value.catch(() => null)
          : null
        signedContext.ready = true
        signedContext.distDir = resolve(String(context.appOutDir), '..')
        signedContext.version = String(context.packager.appInfo.version)
        signedContext.productFilename = productFilename
        signedContext.keychainFile = codeSigningInfo?.keychainFile
          ? String(codeSigningInfo.keychainFile)
          : ''
        appNotaryPromise = (async () => {
          log(`[mac-notary] submitting ${appPath}`)
          await notarizeWithRetry(notarize, { appPath, ...credentials }, appPath, log)
          await verify(appPath)
          log(`[mac-notary] accepted, stapled and verified ${appPath}`)
        })()
      },
      artifactBuildStarted: async (event) => {
        if (event.arch !== ARM64_ARCH) {
          throw new Error('Only Apple Silicon (arm64) macOS artifacts are supported')
        }
        await waitForAppNotarization()
        await config.artifactBuildStarted?.(event)
      },
      artifactBuildCompleted: async (event) => {
        // Sign the DMG inside the packager lifecycle while CI's CSC_LINK temp keychain is still mounted.
        if (event.file?.endsWith('.dmg')) {
          log(`[mac-sign] signing ${event.file}`)
          signMacDmg(event.file, signedContext.keychainFile || null)
        }
        await config.artifactBuildCompleted?.(event)
      }
    }
  })

  await waitForAppNotarization()
  if (!signedContext.ready) {
    throw new Error('macOS signing hook did not record build context')
  }

  const { distDir, version, productFilename } = signedContext
  const zipName = `${productFilename}-${version}-arm64-mac.zip`
  const dmgName = 'coto-macos-arm64.dmg'
  const zipPath = join(distDir, zipName)
  const dmgPath = join(distDir, dmgName)
  if (!existsSync(zipPath) || !existsSync(dmgPath)) {
    throw new Error(`Expected finalized macOS artifacts at ${zipPath} and ${dmgPath}`)
  }

  log(`[mac-verify] validating stapled app inside ${zipPath}`)
  verifyZippedApp(zipPath, productFilename, verify)

  log(`[mac-notary] submitting ${dmgPath}`)
  await notarizeWithRetry(notarize, { appPath: dmgPath, ...credentials }, dmgPath, log)
  verifyDmgIntegrity(dmgPath)
  log(`[mac-notary] accepted, stapled and verified ${dmgPath}`)

  const dmgMeta = await buildBlockMap(dmgPath, 'gzip', `${dmgPath}.blockmap`)
  const zipMeta = {
    size: statSync(zipPath).size,
    sha512: await sha512Base64(zipPath)
  }
  const manifestPaths = await updateMacManifests({ distDir, zipName, dmgName, dmgMeta, zipMeta })

  if (publish === 'always') {
    await publishFinalized({
      version,
      filePaths: [zipPath, `${zipPath}.blockmap`, dmgPath, `${dmgPath}.blockmap`, ...manifestPaths]
    })
  }

  return artifacts
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('macOS release packaging requires Apple Silicon (arm64)')
  }
  const publish = args[0] === '--publish' && ['always', 'never'].includes(args[1]) ? args[1] : null
  if (!publish || args.slice(2).some((arg) => arg !== '--draft') || args.length > 3) {
    throw new Error('Usage: build-mac-notarization-overlap.mjs --publish always|never [--draft]')
  }
  const require = createRequire(import.meta.url)
  const { build, Platform, Arch } = require('electron-builder')
  const builderRequire = createRequire(require.resolve('electron-builder'))
  const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
  const { notarize } = appBuilderRequire('@electron/notarize')
  const { buildBlockMap } = appBuilderRequire('./targets/blockmap/blockmap')
  const { GitHubPublisher } = appBuilderRequire('electron-publish')
  const { CancellationToken } = appBuilderRequire('builder-util-runtime')

  const config = require('../../../electron-builder.config.cjs')
  if (args.includes('--draft')) {
    config.publish = { ...config.publish, releaseType: 'draft' }
  }
  const credentials = process.env.APPLE_KEYCHAIN_PROFILE?.trim()
    ? { keychainProfile: process.env.APPLE_KEYCHAIN_PROFILE.trim() }
    : {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID
      }
  if (Object.values(credentials).some((value) => !value?.trim())) {
    throw new Error('macOS notarization credentials are incomplete')
  }
  return buildWithOverlappingNotarization({
    config,
    build,
    notarize,
    buildBlockMap,
    verify: (appPath) => {
      execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
      execFileSync('xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
      assertMacExecutableUuid(
        join(appPath, 'Contents', 'MacOS', basename(appPath, '.app')),
        config.appId
      )
      assertMacTerminalHostUuid(appPath, config.appId)
    },
    targets: new Map([[Platform.MAC, new Map([[Arch.arm64, ['dmg', 'zip']]])]]),
    publish,
    credentials,
    publishFinalized: ({ version, filePaths }) =>
      publishFinalMacArtifacts({
        config,
        version,
        filePaths,
        GitHubPublisher,
        CancellationToken
      })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error)
    // electron-builder's temp-file exit hook calls process.exit(0) on beforeExit, which discards exitCode.
    process.exit(1)
  })
}
