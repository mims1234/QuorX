// Flutter: one Dart codebase for desktop, Android and the web.
export default {
  id: 'flutter',
  label: 'Flutter',
  summary: 'Desktop and Android apps in Dart',
  toolchains: [{ id: 'flutter', label: 'Flutter', for: 'Flutter apps (desktop and Android)', probe: ['flutter', ['--version']], re: /Flutter (\d+\.\d+\.\d+)/, url: 'https://docs.flutter.dev/get-started/install' }],
  markers: [/^pubspec\.yaml$/],
  notes: () => 'check with flutter analyze, test with flutter test, run on this computer with flutter run -d windows (or macos, linux) as a background job. flutter doctor says what is missing.',
  test: { needs: ['flutter'] },
};
