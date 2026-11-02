#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ "$(uname -s)" != Darwin ]]; then echo 'Build this app on macOS 13+ with Xcode Command Line Tools and Rust.' >&2; exit 1; fi
cargo build --release -p proof-swift-bridge
# SwiftPM's deployment target alone can otherwise stamp LC_BUILD_VERSION.sdk
# with 13.0, selecting legacy AppKit compatibility even on a modern runner.
# Compile AND link against the actual selected SDK; retain macOS 13 deployment.
SDK_PATH="$(xcrun --sdk macosx --show-sdk-path)"
SDK_VERSION="$(xcrun --sdk macosx --show-sdk-version)"
SWIFT_ARGS=(--package-path native/macos -c release --sdk "$SDK_PATH"
  -Xlinker -platform_version -Xlinker macos -Xlinker 13.0 -Xlinker "$SDK_VERSION")
swift build "${SWIFT_ARGS[@]}"
BIN_DIR="$(swift build "${SWIFT_ARGS[@]}" --show-bin-path)"
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
