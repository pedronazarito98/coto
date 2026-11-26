cask "coto" do
  version "1.3.24"
  sha256 "fc707f290ff3b631b7b7947bf339885b61a43d2e89475997c125b61268ed4966"

  url "https://github.com/pedronazarito98/coto/releases/download/v#{version}/coto-macos-arm64.dmg"
  name "Coto"
  desc "IDE for orchestrating AI coding agents across terminals and worktrees"
  homepage "https://coto.app/"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Let the in-app updater own updates between brew upgrades.
  auto_updates true
  conflicts_with cask: "coto@rc"
  depends_on arch: :arm64
  depends_on macos: :tahoe

  app "Coto.app"

  # Expose the symlink-resolving bundled CLI on PATH so headless hosts can use coto serve without the in-app installer.
  binary "#{appdir}/Orca.app/Contents/Resources/bin/coto"

  # Fail cleanly if Homebrew upgrades an auto_updates cask past the app's macOS 26.0 floor.
  preflight_steps do
    run "/bin/sh", args: [
      "-c",
      'case "$(/usr/bin/sw_vers -productVersion)" in [0-9]|1[0-9]|2[0-5]|1[0-9].*|2[0-5].*) ' \
      'echo "Coto needs macOS 26.0 or later. Update macOS to upgrade Coto." >&2; exit 1;; esac',
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
