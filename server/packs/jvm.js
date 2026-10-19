// Java and Kotlin: Gradle and Maven builds (Android builds use the android pack too).
export default {
  id: 'jvm',
  label: 'Java and Kotlin',
  summary: 'Programs, services and libraries on the JVM',
  toolchains: [
    { id: 'java', label: 'Java (JDK)', for: 'Java and Kotlin; Android builds', probe: ['java', ['-version']], re: /version "?(\d+(\.\d+)*)/, winget: 'Microsoft.OpenJDK.21', brew: 'openjdk@21', apt: 'openjdk-21-jdk' },
    { id: 'gradle', label: 'Gradle', for: 'Java/Kotlin and Android builds (most projects bring gradlew)', probe: ['gradle', ['--version']], re: /Gradle (\d+\.\d+(\.\d+)?)/, brew: 'gradle' },
    { id: 'maven', label: 'Maven', for: 'Java builds', probe: ['mvn', ['-v']], re: /Apache Maven (\d+\.\d+\.\d+)/, brew: 'maven', apt: 'maven' },
  ],
  markers: [/^build\.gradle(\.kts)?$/, /^settings\.gradle(\.kts)?$/, /^pom\.xml$/],
  notes: () => 'build with the project\'s own wrapper when it has one (gradlew build, or mvn package); tests with gradlew test or mvn test. For an exception, read the "Caused by" line last in the trace.',
  test: { needs: ['java'] },
};
