// Android: apps built with Gradle, installed and driven on an emulator through adb (the android tool).
import fs from 'node:fs';
import path from 'node:path';

export default {
  id: 'android',
  label: 'Android',
  summary: 'Apps installed and tested on an emulator',
  toolchains: [{ id: 'adb', label: 'Android platform tools (adb)', for: 'Testing Android apps on an emulator or phone', probe: ['adb', ['version']], re: /version (\d+\.\d+\.\d+)/, winget: 'Google.PlatformTools', brew: 'android-platform-tools', apt: 'adb' }],
  // The manifest sits two or three folders down (app/src/main), deeper than a marker scan looks.
  detect: (root) => ['app/src/main/AndroidManifest.xml', 'src/main/AndroidManifest.xml'].some((f) => fs.existsSync(path.join(root, f))),
  notes: () => 'build with gradlew assembleDebug, then use the android tool: install the APK on an emulator, launch it, read the screen, tap and type. For a crash, the android tool\'s logcat shows the exception and its "Caused by" line.',
  test: { needs: ['adb'] },
};
