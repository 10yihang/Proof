#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then echo 'Build this app on macOS 13+ with Xcode Command Line Tools and Rust.' >&2; exit 1; fi
cargo build --release -p proof-swift-bridge
swift build --package-path native/macos -c release
BIN_DIR="$(swift build --package-path native/macos -c release --show-bin-path)"
APP="$PWD/native/macos/build/Proof Native.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN_DIR/ProofNative" "$APP/Contents/MacOS/ProofNative"
cp target/release/proof-swift-bridge "$APP/Contents/MacOS/proof-swift-bridge"
cp native/macos/Info.plist "$APP/Contents/Info.plist"
if [[ -f src-tauri/icons/icon.icns ]]; then cp src-tauri/icons/icon.icns "$APP/Contents/Resources/Proof.icns"; fi
codesign --force --sign - "$APP/Contents/MacOS/proof-swift-bridge"
codesign --force --sign - "$APP"
echo "Built $APP"
echo "Run: open \"$APP\""
