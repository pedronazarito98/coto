cask "coto@rc" do
  arch arm: "arm64", intel: "x64"

  version "1.4.36-rc.3"
  sha256 arm:   "563b6b14323fc9d5489299c82442d514bc12cabffc9d06d3964ed572af4b3955",
         intel: "457088c7021f07de1a419197f7b2bd00092741ad4727d4fef3d86af38a6831e7"

  url "https://github.com/pedronazarito98/coto/releases/download/v#{version}/coto-macos-#{arch}.dmg"
  name "Coto RC"
  desc "IDE for orchestrating AI coding agents across terminals and worktrees"
  homepage "https://coto.app/"

  livecheck do
    url "https://github.com/pedronazarito98/coto"
    regex(/^v?(\d+(?:\.\d+)+-rc\.\d+)$/i)
    strategy :github_releases do |json, regex|
      json.map do |release|
        next if release["draft"]
        next unless release["prerelease"]

        match = release["tag_name"]&.match(regex)
        next if match.blank?

        match[1]
      end
    end
  end

  # Use Coto’s prerelease-aware updater between frequent RCs.
  auto_updates true
  conflicts_with cask: "coto"
  depends_on macos: :ventura

  app "Coto.app"

  # Expose the symlink-resolving bundled CLI on PATH so headless hosts can use coto serve without the in-app installer.
  binary "#{appdir}/Orca.app/Contents/Resources/bin/coto"

  # depends_on can't say 13.4, and Homebrew upgrades auto_updates casks past the in-app updater's macOS gate.
  preflight_steps do
    run "/bin/sh", args: [
      "-c",
      'case "$(/usr/bin/sw_vers -productVersion)" in 13|13.[0-3]|13.[0-3].*) ' \
      'echo "Coto needs macOS 13.4 or later. Update macOS to upgrade Coto." >&2; exit 1;; esac',
    ]
  end

  # Zap app-created ~/.orca and Electron userData for a clean uninstall.
  zap trash: [
    "~/.orca",
    "~/Library/Application Support/Orca",
    "~/Library/Caches/com.coto.app",
    "~/Library/Caches/com.coto.app.ShipIt",
    "~/Library/HTTPStorages/com.coto.app",
    "~/Library/Preferences/com.coto.app.plist",
    "~/Library/Saved Application State/com.coto.app.savedState",
  ]
end
