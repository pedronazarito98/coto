const { execFileSync } = require('node:child_process')

function listInstalledMacSigningIdentities(keychainFile) {
  try {
    const output = execFileSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning', ...(keychainFile ? [keychainFile] : [])],
      { encoding: 'utf8' }
    )
    return [...output.matchAll(/"([^"]+)"/g)].map((match) => match[1])
  } catch {
    return []
  }
}

function findInstalledMacSigningIdentity(keychainFile, { allowDevelopment = false } = {}) {
  const names = listInstalledMacSigningIdentities(keychainFile)
  const release =
    names.find((name) => name.includes('Developer ID Application:')) ??
    names.find((name) => name.includes('Apple Distribution:'))
  if (allowDevelopment) {
    return names.find((name) => name.includes('Apple Development:')) ?? release ?? null
  }
  return release ?? null
}

function resolveExplicitMacSigningIdentity(explicitIdentity, keychainFile) {
  if (!explicitIdentity || explicitIdentity === '-') {
    return explicitIdentity ?? null
  }
  const names = listInstalledMacSigningIdentities(keychainFile)
  const exact = names.find((name) => name === explicitIdentity)
  if (exact) {
    return exact
  }
  const developerId = names.find((name) => name === `Developer ID Application: ${explicitIdentity}`)
  if (developerId) {
    return developerId
  }
  const substringMatches = names.filter((name) => name.includes(explicitIdentity))
  if (substringMatches.length === 1) {
    return substringMatches[0]
  }
  return explicitIdentity
}

module.exports = {
  findInstalledMacSigningIdentity,
  resolveExplicitMacSigningIdentity
}
