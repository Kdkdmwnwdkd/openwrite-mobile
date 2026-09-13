#!/bin/bash
# OpenWrite Mobile - Build Script
# Builds the Android APK from the PWA frontend

set -e

echo "========================================"
echo "OpenWrite Mobile - Build Script"
echo "========================================"

# Check prerequisites
check_command() {
    if ! command -v "$1" &> /dev/null; then
        echo "❌ $1 is not installed. Please install it first."
        return 1
    fi
    echo "✅ $1 found: $(command -v $1)"
}

echo ""
echo "Checking prerequisites..."
check_command node || exit 1
check_command npm || exit 1
check_command python3 || exit 1

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 22 ]; then
    echo "⚠️  Node.js version is $NODE_VERSION, but Capacitor requires >= 22.0.0"
    echo "Please upgrade Node.js: https://nodejs.org/"
    exit 1
fi

echo ""
echo "✅ All prerequisites satisfied"
echo ""

# Install dependencies
echo "Installing Node.js dependencies..."
npm install

echo ""
echo "Installing Python dependencies..."
cd backend
pip install -r requirements.txt
cd ..

# Check if Capacitor platforms are added
echo ""
echo "Checking Capacitor platforms..."

if [ ! -d "android" ]; then
    echo "Adding Android platform..."
    npx cap add android
fi

# Sync web assets to native projects
echo ""
echo "Syncing web assets..."
npx cap sync

# Build Android APK
echo ""
echo "Building Android APK..."
cd android
./gradlew assembleDebug

echo ""
echo "========================================"
echo "✅ Build completed!"
echo "========================================"
echo ""
echo "APK location: android/app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "To install on your device:"
echo "  adb install android/app/build/outputs/apk/debug/app-debug.apk"
echo ""
echo "To open in Android Studio:"
echo "  npx cap open android"
echo ""
