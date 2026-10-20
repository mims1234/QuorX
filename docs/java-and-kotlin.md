# Java and Kotlin in QuorX

QuorX helps build and debug Java and Kotlin programs: command-line tools, Swing and JavaFX desktop apps, services and
libraries, with Gradle, Maven, or a single `.java` file. Android apps use the Android pack as well. This page says
what QuorX does for them, and how to test it on your computer. See [platform-packs.md](platform-packs.md) for packs in
general.

## What QuorX does

| | |
|---|---|
| **Detect** | Finds the JDK (`JAVA_HOME` first, then `java` on PATH) and checks that it really builds: it compiles and runs a tiny program, so a Java runtime without the JDK is caught. Also finds Gradle, Maven and the Kotlin compiler (`kotlinc`). Offers Microsoft's OpenJDK 21 through winget. |
| **Check** | Before the final reply, compiles the projects whose `.java`, `.kt` or `.kts` files the reply changed, with the project's own wrapper (`gradlew`, `mvnw`) when it has one: `gradlew testClasses -q` or `mvn -q -B test-compile` (main code and tests, Java and Kotlin). Only errors in changed files count, shown as `src/main/java/App.java:5: message`. Android modules are left to the Android pack. |
| **Run and drive** | After `gradlew test`, `mvn test` and the like, the agent gets a short summary read from the JUnit XML reports (`build/test-results`, `target/surefire-reports`): how many failed, and each failure's message and line. Programs that read the keyboard run in the terminal tool. Desktop apps run in the background and are driven with the desktop tool (see below). |
| **Debug** | The debug tool runs a `.java` or `.kt` file that has a `main` under the JDK's own debugger: breakpoints (with conditions), stepping, the stack, local variables, and expressions. Uncaught exceptions stop where they were thrown. |
| **Explain** | Notes for the agent: use the wrapper, how to run one test class, read "Caused by:" from the last one, Kotlin's `e:` errors, and `jdb` for tests and servers. |

### Desktop windows

- **JavaFX** windows show their controls to UI Automation (JavaFX supports it on Windows), so the desktop tool can
  read and click them like WPF or WinForms.
- **Swing and AWT** windows show as one empty pane. UI Automation can't see inside them. Java Access Bridge
  (`jabswitch -enable`) doesn't change that: it speaks its own protocol to screen readers such as NVDA, not UI
  Automation. So the agent drives Swing with keys (Tab, Space, Enter, Alt+letter) and `click_at`, and checks results in
  the program's output or in tests.

### How debugging works

QuorX talks the Debug Adapter Protocol to every debugger. For Java and Kotlin it ships a small adapter,
`server/packs/jvm-debug/QxDebug.java`, built on the JDK's own debugger interface (JDI). The JDK runs it straight from
its source, so **a JDK is all it needs**: nothing to download, no editor or language server. It builds the program
first (with `javac -g` for a lone `.java` file, `kotlinc` for a lone `.kt` file, or the project's Gradle or Maven
build for its class path), starts it paused, and runs it once QuorX has set the breakpoints.

Why not the others:

- Microsoft's java-debug adapter (the one VS Code uses) only runs inside the Eclipse JDT language server. QuorX
  would have to install, start and import the project into a language server before every session.
- `jdb` through the terminal tool works with nothing extra, and the agent's notes say how to use it for what the
  debug tool doesn't start: tests (`gradlew test --debug-jvm`, `mvn -Dmaven.surefire.debug test`) and servers, then
  `jdb -connect com.sun.jdi.SocketAttach:hostname=127.0.0.1,port=5005`. But typing jdb commands is slower and easier
  to get wrong than the debug tool's breakpoints and variables.

Expressions the adapter evaluates: variables, fields, array items, `.length`, calls without arguments
(`name.length()`, `list.size()`, `x.toString()`), literals, `+ - * / %`, comparisons, `&&`, `||` and `!`.

### Good to know

- Gradle's daemon makes repeat builds quick, but QuorX ends whatever a command leaves running (so Stop always stops
  everything), which includes the daemon. Each check starts one, a few seconds.
- The very first Gradle or Maven build downloads the build tool and the libraries and can take minutes. If the check
  times out, it says so and asks the agent to run the build once with the shell tool, where a slow command moves to
  the background instead of being stopped.
- Maven builds offline (`-o`) once the project has been built on this computer (`target/classes` exists), so the
  check doesn't wait on the network.

## Testing it

You need a JDK 17 or 21 (`winget install --id Microsoft.OpenJDK.21 -e`, or any other JDK), and Gradle or Maven on
PATH for the build tests. Then:

```bash
npm run test:packs -- --pack jvm
```

Paste `pack-test-report.md` into the pull request. The self-test checks that QuorX sees a working JDK, a one-file
program runs, the debugger stops at a breakpoint, steps and reads variables, it stops at an uncaught exception, a Swing
window is found and pressed with a key and with `click_at`, the compiler check catches an error in a changed Java file
and a Kotlin file, a failing JUnit test is summarised, and the debugger builds a Gradle project and stops in a `.java`
and a `.kt` file. Five more tests (report parsing, error lines, the wrapper, the whole check through a stand-in
`gradlew`) run without a JDK.

Portable tools work too, without installing them or changing PATH: point `JAVA_HOME` at an unzipped JDK, and
`QX_GRADLE` at an unzipped Gradle's `bin\gradle.bat`. The tests then give each test project its own Gradle wrapper,
the way most projects come; set `QX_GRADLE_DIST` to that Gradle's zip so the wrapper doesn't download it again, and
`GRADLE_USER_HOME` to keep Gradle's downloads in a folder of your choosing.
