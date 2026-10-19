// QuorX's Java and Kotlin debugger: a small Debug Adapter Protocol server on the JDK's own debugger interface (JDI).
// The JDK runs it straight from this source file, so a JDK 11 or newer is all it needs:
//
//   java --add-modules jdk.jdi QxDebug.java <port>
//
// It listens on 127.0.0.1:<port> for one client (QuorX, server/debugger.js). On "launch" ({ file, args, cwd }) it
// builds the program (javac -g for a lone .java file, kotlinc for a lone .kt file, or the project's own Gradle or
// Maven build), starts it suspended under JDWP, and runs it once the client has set its breakpoints
// (configurationDone). Breakpoints bind as their classes load. Uncaught exceptions stop the program where they were
// thrown. Expressions: variables, fields, array items, .length, calls without arguments (s.length(), x.toString()),
// literals, comparisons, && || and !.
//
// The program's own output goes to this process's output, which QuorX keeps in the debug job's log.
import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.regex.*;

public class QxDebug {
  public static void main(String[] argv) throws Exception {
    int port = Integer.parseInt(argv[0]);
    try (ServerSocket server = new ServerSocket(port, 1, InetAddress.getByName("127.0.0.1"))) {
      Socket sock = server.accept();
      new Adapter(sock).serve();
    }
    System.exit(0);
  }

  // ---------- JSON (just enough for DAP) ----------
  static Object parse(String s) { return new Json(s).value(); }
  static final class Json {
    final String s; int i;
    Json(String s) { this.s = s; }
    void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }
    Object value() {
      ws();
      char c = s.charAt(i);
      if (c == '{') { i++; Map<String, Object> m = new LinkedHashMap<>(); ws(); if (s.charAt(i) == '}') { i++; return m; }
        for (;;) { ws(); String k = str(); ws(); i++; m.put(k, value()); ws(); if (s.charAt(i++) == '}') return m; } }
      if (c == '[') { i++; List<Object> l = new ArrayList<>(); ws(); if (s.charAt(i) == ']') { i++; return l; }
        for (;;) { l.add(value()); ws(); if (s.charAt(i++) == ']') return l; } }
      if (c == '"') return str();
      if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
      if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
      if (s.startsWith("null", i)) { i += 4; return null; }
      int j = i; while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
      return Double.parseDouble(s.substring(j, i));
    }
    String str() {
      StringBuilder b = new StringBuilder(); i++;
      for (;;) {
        char c = s.charAt(i++);
        if (c == '"') return b.toString();
        if (c != '\\') { b.append(c); continue; }
        char e = s.charAt(i++);
        switch (e) {
          case 'n': b.append('\n'); break; case 't': b.append('\t'); break; case 'r': b.append('\r'); break;
          case 'b': b.append('\b'); break; case 'f': b.append('\f'); break;
          case 'u': b.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
          default: b.append(e);
        }
      }
    }
  }
  static String json(Object o) {
    if (o == null) return "null";
    if (o instanceof String) {
      StringBuilder b = new StringBuilder("\"");
      for (char c : ((String) o).toCharArray()) {
        if (c == '"' || c == '\\') b.append('\\').append(c);
        else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
        else b.append(c);
      }
      return b.append('"').toString();
    }
    if (o instanceof Map) {
      StringJoiner j = new StringJoiner(",", "{", "}");
      for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) j.add(json(String.valueOf(e.getKey())) + ":" + json(e.getValue()));
      return j.toString();
    }
    if (o instanceof Double && ((Double) o) == Math.rint((Double) o) && !((Double) o).isInfinite()) return String.valueOf(((Double) o).longValue());
    if (o instanceof Collection) { StringJoiner j = new StringJoiner(",", "[", "]"); for (Object x : (Collection<?>) o) j.add(json(x)); return j.toString(); }
    return String.valueOf(o);
  }
  static Map<String, Object> obj(Object... kv) { Map<String, Object> m = new LinkedHashMap<>(); for (int k = 0; k < kv.length; k += 2) m.put((String) kv[k], kv[k + 1]); return m; }
  @SuppressWarnings("unchecked") static Map<String, Object> map(Object o) { return o instanceof Map ? (Map<String, Object>) o : new HashMap<>(); }
  static int num(Object o) { return o instanceof Number ? ((Number) o).intValue() : 0; }

  // ---------- the adapter ----------
  static final class Bp { final int line; final String condition; final List<BreakpointRequest> reqs = new ArrayList<>(); Bp(int l, String c) { line = l; condition = c; } }
  static final class Src { final Path path; final String name, pkg; final List<Bp> bps = new ArrayList<>(); ClassPrepareRequest prep;
    Src(Path p) { path = p; name = p.getFileName().toString(); pkg = packageOf(p); } }
  static final class Ref { final ThreadReference thread; final int depth; final Value value; Ref(ThreadReference t, int d, Value v) { thread = t; depth = d; value = v; } }

  static final class Adapter {
    final Socket sock; final InputStream in; final OutputStream out;
    final Object lock = new Object();
    final Map<Path, Src> sources = new LinkedHashMap<>();
    final Map<Integer, Ref> frames = new HashMap<>(), vars = new HashMap<>();
    final List<Path> sourceRoots = new ArrayList<>();
    int nextRef = 1, seq = 1;
    VirtualMachine vm; Process proc;
    volatile boolean configured, started, ended;
    ThreadReference stoppedThread;

    Adapter(Socket s) throws IOException { sock = s; in = new BufferedInputStream(s.getInputStream()); out = s.getOutputStream(); }

    void send(Map<String, Object> m) {
      synchronized (out) {
        try {
          m.put("seq", seq++);
          byte[] body = json(m).getBytes(StandardCharsets.UTF_8);
          out.write(("Content-Length: " + body.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
          out.write(body); out.flush();
        } catch (IOException e) { /* the client has gone */ }
      }
    }
    void event(String name, Map<String, Object> body) { send(obj("type", "event", "event", name, "body", body)); }
    void log(String text) { System.err.println("[QuorX debugger] " + text); event("output", obj("category", "console", "output", text + "\n")); }

    String readMessage() throws IOException {
      int len = -1; StringBuilder h = new StringBuilder();
      for (;;) {
        int c = in.read();
        if (c < 0) return null;
        if (c == '\n') {
          String l = h.toString().trim(); h.setLength(0);
          if (l.isEmpty()) { if (len >= 0) break; continue; }
          if (l.toLowerCase(Locale.ROOT).startsWith("content-length:")) len = Integer.parseInt(l.substring(15).trim());
        } else h.append((char) c);
      }
      byte[] b = in.readNBytes(len);
      return new String(b, StandardCharsets.UTF_8);
    }

    void serve() throws IOException {
      for (String msg; (msg = readMessage()) != null; ) {
        Map<String, Object> req = map(parse(msg));
        String cmd = String.valueOf(req.get("command"));
        Map<String, Object> args = map(req.get("arguments"));
        Map<String, Object> res = obj("type", "response", "request_seq", req.get("seq"), "command", cmd, "success", true);
        try {
          Object body = handle(cmd, args);
          if (body != null) res.put("body", body);
        } catch (Exception e) {
          res.put("success", false); res.put("message", e.getMessage() == null ? e.toString() : e.getMessage());
        }
        send(res);
        if (cmd.equals("disconnect") || cmd.equals("terminate")) { shutdown(); return; }
      }
      shutdown();
    }

    void shutdown() {
      try { if (vm != null && !ended) vm.exit(1); } catch (Exception e) { /* gone */ }
      if (proc != null) proc.destroy();
      try { sock.close(); } catch (IOException e) { /* closed */ }
    }

    Object handle(String cmd, Map<String, Object> a) throws Exception {
      switch (cmd) {
        case "initialize":
          return obj("supportsConfigurationDoneRequest", true, "supportsConditionalBreakpoints", true, "supportsEvaluateForHovers", true, "supportsTerminateRequest", true);
        case "launch": case "attach": {
          Thread t = new Thread(() -> launch(a), "qx-launch"); t.setDaemon(true); t.start();
          return null;
        }
        case "setBreakpoints": return setBreakpoints(a);
        case "setExceptionBreakpoints": return obj();
        case "configurationDone": synchronized (lock) { configured = true; if (started) vm.resume(); } return null;
        case "threads": {
          List<Object> l = new ArrayList<>();
          if (vm != null) for (ThreadReference t : vm.allThreads()) l.add(obj("id", (int) t.uniqueID(), "name", t.name()));
          return obj("threads", l);
        }
        case "stackTrace": return stackTrace(a);
        case "scopes": {
          synchronized (lock) {
            Ref f = frames.get(num(a.get("frameId")));
            if (f == null) throw new IllegalStateException("that frame is gone: the program has moved on");
            int id = nextRef++; vars.put(id, new Ref(f.thread, f.depth, null));
            return obj("scopes", List.of(obj("name", "Locals", "variablesReference", id, "expensive", false)));
          }
        }
        case "variables": return obj("variables", variables(num(a.get("variablesReference"))));
        case "continue": resume(); return obj("allThreadsContinued", true);
        case "next": step(a, StepRequest.STEP_OVER); return null;
        case "stepIn": step(a, StepRequest.STEP_INTO); return null;
        case "stepOut": step(a, StepRequest.STEP_OUT); return null;
        case "pause": {
          if (vm == null) return null;
          vm.suspend();
          ThreadReference main = vm.allThreads().stream().filter(t -> t.name().equals("main")).findFirst().orElse(vm.allThreads().get(0));
          stopped("pause", main, null);
          return null;
        }
        case "evaluate": {
          Ref f = frames.get(num(a.get("frameId")));
          if (f == null && stoppedThread != null) f = new Ref(stoppedThread, 0, null);
          if (f == null) throw new IllegalStateException("the program is not paused");
          Value v = new Eval(f.thread, f.depth, String.valueOf(a.get("expression"))).run();
          return obj("result", show(v), "variablesReference", expandable(v) ? keep(f, v) : 0);
        }
        case "disconnect": case "terminate": return null;
        default: throw new UnsupportedOperationException("not supported: " + cmd);
      }
    }

    // ---------- building and starting the program ----------
    void launch(Map<String, Object> a) {
      try {
        Path cwd = Paths.get(String.valueOf(a.getOrDefault("cwd", "."))).toAbsolutePath();
        Path file = cwd.resolve(String.valueOf(a.get("file"))).normalize();
        List<String> progArgs = new ArrayList<>();
        Object pa = a.get("args"); if (pa instanceof List) for (Object x : (List<?>) pa) progArgs.add(String.valueOf(x));
        if (!Files.exists(file)) throw new IOException("no file " + file);
        String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
        String main = mainClass(file, text);
        Path work = Files.createTempDirectory("qx-jdebug-");
        Build b = Build.of(file);
        String cp; Path runIn = cwd;
        if (b == null) {
          cp = compileAlone(file, text, work);
          sourceRoots.add(packageRoot(file));
        } else {
          cp = b.classpath(work, this::log);
          runIn = b.dir;
          for (String s : new String[] { "src/main/java", "src/main/kotlin", "src/test/java", "src/test/kotlin" }) sourceRoots.add(b.dir.resolve(s));
        }
        log("starting " + main + (progArgs.isEmpty() ? "" : " " + String.join(" ", progArgs)));
        start(main, cp, progArgs, runIn, work);
      } catch (Exception e) {
        log("could not start the program: " + (e.getMessage() == null ? e : e.getMessage()));
        ended = true;
        event("terminated", obj());
      }
    }

    String compileAlone(Path file, String text, Path work) throws Exception {
      Path classes = Files.createDirectories(work.resolve("classes"));
      if (file.toString().endsWith(".kt")) {
        Path jar = work.resolve("app.jar");
        List<String> cmd = tool(null, "kotlinc", file.getParent());
        cmd.addAll(List.of(file.toString(), "-include-runtime", "-d", jar.toString()));
        if (runTool(cmd, file.getParent(), this::log) != 0 || !Files.exists(jar)) throw new IOException("kotlinc could not build " + file.getFileName() + " (is kotlinc installed?)");
        return jar.toString();
      }
      javax.tools.JavaCompiler javac = javax.tools.ToolProvider.getSystemJavaCompiler();
      if (javac == null) throw new IOException("this Java has no compiler (a JDK is needed, not just a runtime)");
      ByteArrayOutputStream err = new ByteArrayOutputStream();
      int code = javac.run(null, err, err, "-g", "-encoding", "UTF-8", "-d", classes.toString(), "-sourcepath", packageRoot(file).toString(), file.toString());
      if (code != 0) throw new IOException("javac found errors:\n" + err.toString(StandardCharsets.UTF_8.name()).trim());
      return classes.toString();
    }

    void start(String main, String cp, List<String> progArgs, Path dir, Path work) throws Exception {
      ListeningConnector lc = (ListeningConnector) Bootstrap.virtualMachineManager().listeningConnectors().stream()
        .filter(c -> c.name().equals("com.sun.jdi.SocketListen")).findFirst().orElseThrow(() -> new IOException("this JDK has no socket debugger connector"));
      Map<String, Connector.Argument> ca = lc.defaultArguments();
      ca.get("port").setValue("0");
      if (ca.containsKey("localAddress")) ca.get("localAddress").setValue("127.0.0.1");
      if (ca.containsKey("timeout")) ca.get("timeout").setValue("30000");
      String address = lc.startListening(ca);
      String port = address.substring(address.lastIndexOf(':') + 1);
      // The class path goes in an argument file: Gradle's can be longer than Windows allows on a command line.
      Path argfile = work.resolve("java.args");
      Files.write(argfile, List.of("-cp", "\"" + cp.replace('\\', '/') + "\""), StandardCharsets.UTF_8);
      List<String> cmd = new ArrayList<>(List.of(Paths.get(System.getProperty("java.home"), "bin", "java").toString(),
        "-agentlib:jdwp=transport=dt_socket,server=n,suspend=y,address=127.0.0.1:" + port, "@" + argfile, main));
      cmd.addAll(progArgs);
      proc = new ProcessBuilder(cmd).directory(dir.toFile()).start();
      pump(proc.getInputStream(), System.out, this, "stdout"); pump(proc.getErrorStream(), System.err, this, "stderr");
      Thread feed = new Thread(() -> { try { System.in.transferTo(proc.getOutputStream()); } catch (IOException e) { /* closed */ } }); feed.setDaemon(true); feed.start();
      Runtime.getRuntime().addShutdownHook(new Thread(() -> { if (proc.isAlive()) proc.destroyForcibly(); }));
      vm = lc.accept(ca);
      lc.stopListening(ca);
      EventRequestManager erm = vm.eventRequestManager();
      ExceptionRequest ex = erm.createExceptionRequest(null, false, true);
      ex.setSuspendPolicy(EventRequest.SUSPEND_ALL); ex.enable();
      synchronized (lock) { for (Src s : sources.values()) bind(s); }
      Thread t = new Thread(this::events, "qx-events"); t.setDaemon(true); t.start();
      event("initialized", obj());
    }

    // ---------- JDI events ----------
    void events() {
      try {
        for (;;) {
          EventSet set = vm.eventQueue().remove();
          boolean stay = false;
          for (Event e : set) {
            if (e instanceof VMStartEvent) { synchronized (lock) { started = true; if (configured) { vm.resume(); } } stay = true; }
            else if (e instanceof ClassPrepareEvent) { synchronized (lock) { ReferenceType rt = ((ClassPrepareEvent) e).referenceType(); for (Src s : sources.values()) bindType(s, rt); } }
            else if (e instanceof BreakpointEvent) {
              BreakpointEvent be = (BreakpointEvent) e;
              String cond = (String) be.request().getProperty("condition");
              if (cond != null && !holds(be.thread(), cond)) continue;
              stopped("breakpoint", be.thread(), null); stay = true;
            } else if (e instanceof StepEvent) {
              vm.eventRequestManager().deleteEventRequest(e.request());
              stopped("step", ((StepEvent) e).thread(), null); stay = true;
            } else if (e instanceof ExceptionEvent) {
              ExceptionEvent xe = (ExceptionEvent) e;
              if (loading(xe.thread())) continue;
              stopped("exception", xe.thread(), "Uncaught " + xe.exception().referenceType().name() + describe(xe.thread(), xe.exception()));
              stay = true;
            } else if (e instanceof VMDeathEvent || e instanceof VMDisconnectEvent) { finish(); return; }
          }
          if (!stay) set.resume();
        }
      } catch (InterruptedException | VMDisconnectedException e) { finish(); }
    }

    void finish() {
      if (ended) return;
      ended = true;
      int code = 0;
      try { if (proc != null && proc.waitFor(3, TimeUnit.SECONDS)) code = proc.exitValue(); } catch (InterruptedException e) { /* no code */ }
      event("exited", obj("exitCode", code));
      event("terminated", obj());
      // The program is over, and so is this debug job.
      Thread t = new Thread(() -> { try { Thread.sleep(500); } catch (InterruptedException e) { /* now */ } shutdown(); System.exit(0); }); t.setDaemon(true); t.start();
    }

    // Exceptions the JDK's class loading throws into native code look uncaught to the debugger; they are not the
    // program's.
    static boolean loading(ThreadReference t) {
      try {
        for (StackFrame f : t.frames()) {
          String type = f.location().declaringType().name(), m = f.location().method().name();
          if (!type.matches("(java|javax|jdk|sun|com\\.sun)\\..*")) return false;
          if (m.equals("loadClass") || m.equals("findClass") || m.equals("forName0")) return true;
        }
      } catch (IncompatibleThreadStateException e) { /* not suspended */ }
      return false;
    }

    String describe(ThreadReference t, ObjectReference ex) {
      try { Value m = invoke(t, ex, "getMessage"); return m instanceof StringReference ? ": " + ((StringReference) m).value() : ""; } catch (Exception e) { return ""; }
    }

    void stopped(String reason, ThreadReference t, String text) {
      synchronized (lock) { frames.clear(); vars.clear(); stoppedThread = t; }
      Map<String, Object> b = obj("reason", reason, "threadId", (int) t.uniqueID(), "allThreadsStopped", true);
      if (text != null) b.put("text", text);
      event("stopped", b);
    }

    void resume() {
      if (vm == null) return;
      synchronized (lock) { frames.clear(); vars.clear(); stoppedThread = null; }
      vm.resume();
    }

    void step(Map<String, Object> a, int depth) {
      ThreadReference t = thread(num(a.get("threadId")));
      EventRequestManager erm = vm.eventRequestManager();
      for (StepRequest r : new ArrayList<>(erm.stepRequests())) if (r.thread().equals(t)) erm.deleteEventRequest(r);
      StepRequest r = erm.createStepRequest(t, StepRequest.STEP_LINE, depth);
      for (String x : new String[] { "java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "kotlin.*" }) r.addClassExclusionFilter(x);
      r.addCountFilter(1); r.setSuspendPolicy(EventRequest.SUSPEND_ALL); r.enable();
      resume();
    }

    ThreadReference thread(int id) {
      if (vm == null) throw new IllegalStateException("the program has not started");
      for (ThreadReference t : vm.allThreads()) if ((int) t.uniqueID() == id) return t;
      if (stoppedThread != null) return stoppedThread;
      throw new IllegalStateException("no thread " + id);
    }

    // ---------- breakpoints ----------
    Object setBreakpoints(Map<String, Object> a) {
      Path p = Paths.get(String.valueOf(map(a.get("source")).get("path"))).toAbsolutePath().normalize();
      List<Object> res = new ArrayList<>();
      synchronized (lock) {
        Src s = sources.get(p);
        if (s == null) { s = new Src(p); sources.put(p, s); }
        if (vm != null) for (Bp b : s.bps) for (BreakpointRequest r : b.reqs) vm.eventRequestManager().deleteEventRequest(r);
        s.bps.clear();
        Object list = a.get("breakpoints");
        if (list instanceof List) for (Object o : (List<?>) list) { Map<String, Object> m = map(o); s.bps.add(new Bp(num(m.get("line")), (String) m.get("condition"))); }
        if (vm != null) bind(s);
        boolean loaded = vm != null && !typesOf(s).isEmpty();
        for (Bp b : s.bps) {
          boolean ok = !loaded || !b.reqs.isEmpty();
          Map<String, Object> r = obj("verified", ok, "line", b.reqs.isEmpty() ? b.line : b.reqs.get(0).location().lineNumber());
          if (!loaded) r.put("message", "set: it binds when its class loads");
          else if (!ok) r.put("message", "no code on that line");
          res.add(r);
        }
      }
      return obj("breakpoints", res);
    }

    List<ReferenceType> typesOf(Src s) {
      List<ReferenceType> l = new ArrayList<>();
      for (ReferenceType rt : vm.allClasses()) if (fromSource(rt, s)) l.add(rt);
      return l;
    }
    static boolean fromSource(ReferenceType rt, Src s) {
      try { if (!rt.sourceName().equals(s.name)) return false; } catch (AbsentInformationException e) { return false; }
      return s.pkg.isEmpty() ? rt.name().indexOf('.') < 0 : rt.name().startsWith(s.pkg + ".") && rt.name().indexOf('.', s.pkg.length() + 1) < 0;
    }
    void bind(Src s) {
      if (s.prep == null) {
        s.prep = vm.eventRequestManager().createClassPrepareRequest();
        s.prep.addSourceNameFilter(s.name); s.prep.setSuspendPolicy(EventRequest.SUSPEND_ALL); s.prep.enable();
      }
      for (ReferenceType rt : typesOf(s)) bindType(s, rt);
    }
    void bindType(Src s, ReferenceType rt) {
      if (!fromSource(rt, s)) return;
      for (Bp b : s.bps) {
        try {
          for (Location loc : rt.locationsOfLine(b.line)) {
            if (b.reqs.stream().anyMatch(x -> x.location().equals(loc))) continue;
            BreakpointRequest r = vm.eventRequestManager().createBreakpointRequest(loc);
            r.setSuspendPolicy(EventRequest.SUSPEND_ALL);
            if (b.condition != null && !b.condition.isBlank()) r.putProperty("condition", b.condition);
            r.enable(); b.reqs.add(r);
          }
        } catch (AbsentInformationException e) { /* compiled without line numbers */ }
      }
    }
    boolean holds(ThreadReference t, String cond) {
      try { Value v = new Eval(t, 0, cond).run(); return v instanceof BooleanValue && ((BooleanValue) v).value(); }
      catch (Exception e) { log("breakpoint condition " + cond + " failed: " + e.getMessage()); return true; }
    }

    // ---------- stack and variables ----------
    Object stackTrace(Map<String, Object> a) throws Exception {
      ThreadReference t = thread(num(a.get("threadId")));
      int levels = Math.max(1, Math.min(num(a.get("levels")) == 0 ? 20 : num(a.get("levels")), 50));
      List<StackFrame> fs = t.frames();
      List<Object> l = new ArrayList<>();
      synchronized (lock) {
        for (int d = 0; d < Math.min(levels, fs.size()); d++) {
          Location loc = fs.get(d).location();
          int id = nextRef++; frames.put(id, new Ref(t, d, null));
          String type = loc.declaringType().name();
          Map<String, Object> f = obj("id", id, "name", type.substring(type.lastIndexOf('.') + 1) + "." + loc.method().name(), "line", Math.max(loc.lineNumber(), 0), "column", 1);
          Map<String, Object> src = sourceOf(loc);
          if (src != null) f.put("source", src);
          l.add(f);
        }
      }
      return obj("stackFrames", l, "totalFrames", fs.size());
    }
    Map<String, Object> sourceOf(Location loc) {
      try {
        String rel = loc.sourcePath();
        for (Src s : sources.values()) if (s.path.toString().replace('\\', '/').endsWith(rel)) return obj("name", s.name, "path", s.path.toString());
        for (Path r : sourceRoots) { Path p = r.resolve(rel); if (Files.exists(p)) return obj("name", p.getFileName().toString(), "path", p.toString()); }
        return obj("name", loc.sourceName());
      } catch (AbsentInformationException e) { return null; }
    }

    List<Object> variables(int ref) throws Exception {
      Ref r = vars.get(ref);
      if (r == null) throw new IllegalStateException("those variables are gone: the program has moved on");
      List<Object> l = new ArrayList<>();
      if (r.value == null) { // a frame's locals
        StackFrame f = r.thread.frame(r.depth);
        ObjectReference self = f.thisObject();
        if (self != null) l.add(variable("this", self, r));
        try { for (LocalVariable v : f.visibleVariables()) l.add(variable(v.name(), f.getValue(v), r)); }
        catch (AbsentInformationException e) { l.add(obj("name", "(no local variables)", "value", "compiled without debug information (javac -g)", "variablesReference", 0)); }
      } else if (r.value instanceof ArrayReference) {
        ArrayReference arr = (ArrayReference) r.value;
        int n = Math.min(arr.length(), 100);
        for (int k = 0; k < n; k++) l.add(variable("[" + k + "]", arr.getValue(k), r));
      } else if (r.value instanceof ObjectReference) {
        ObjectReference o = (ObjectReference) r.value;
        for (Field fd : o.referenceType().allFields()) if (!fd.isStatic()) l.add(variable(fd.name(), o.getValue(fd), r));
      }
      return l;
    }
    Map<String, Object> variable(String name, Value v, Ref at) {
      return obj("name", name, "value", show(v), "type", v == null ? "null" : v.type().name(), "variablesReference", expandable(v) ? keep(at, v) : 0);
    }
    boolean expandable(Value v) { return v instanceof ArrayReference || (v instanceof ObjectReference && !(v instanceof StringReference) && boxed((ObjectReference) v) == null); }
    int keep(Ref at, Value v) { synchronized (lock) { int id = nextRef++; vars.put(id, new Ref(at.thread, at.depth, v)); return id; } }

    // ---------- expressions ----------
    final class Eval {
      final ThreadReference t; final int depth; final List<String> tok = new ArrayList<>(); int p;
      Eval(ThreadReference t, int depth, String src) {
        this.t = t; this.depth = depth;
        Matcher m = Pattern.compile("\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)'|\\d+(?:\\.\\d+)?[LlFfDd]?|[A-Za-z_$][\\w$]*|==|!=|<=|>=|&&|\\|\\||[-+*/%<>!().\\[\\]])").matcher(src);
        int at = 0;
        while (at < src.length() && m.find(at) && m.start() == at) { tok.add(m.group(1)); at = m.end(); }
        if (src.substring(at).trim().length() > 0) throw new IllegalArgumentException("can't read the expression from: " + src.substring(at).trim());
      }
      String peek() { return p < tok.size() ? tok.get(p) : ""; }
      boolean eat(String s) { if (peek().equals(s)) { p++; return true; } return false; }
      Value run() throws Exception { Object v = or(); if (p < tok.size()) throw new IllegalArgumentException("unexpected " + peek()); return mirror(v); }
      StackFrame frame() throws IncompatibleThreadStateException { return t.frame(depth); }

      Object or() throws Exception { Object a = and(); while (eat("||")) { Object b = and(); a = truthy(a) || truthy(b); } return a; }
      Object and() throws Exception { Object a = cmp(); while (eat("&&")) { Object b = cmp(); a = truthy(a) && truthy(b); } return a; }
      Object cmp() throws Exception {
        Object a = sum();
        for (String op : new String[] { "==", "!=", "<=", ">=", "<", ">" }) if (eat(op)) return compare(a, sum(), op);
        return a;
      }
      Object sum() throws Exception {
        Object a = unary();
        for (;;) {
          String op = peek();
          if (!List.of("+", "-", "*", "/", "%").contains(op)) return a;
          p++; Object b = unary();
          Object x = plain(a), y = plain(b);
          if (op.equals("+") && (x instanceof String || y instanceof String)) { a = String.valueOf(x) + y; continue; }
          if (!(x instanceof Number) || !(y instanceof Number)) throw new IllegalArgumentException(op + " needs numbers");
          boolean whole = !(x instanceof Double || x instanceof Float || y instanceof Double || y instanceof Float);
          if (whole) { long l = ((Number) x).longValue(), r = ((Number) y).longValue();
            a = op.equals("+") ? l + r : op.equals("-") ? l - r : op.equals("*") ? l * r : op.equals("/") ? l / r : l % r; }
          else { double l = ((Number) x).doubleValue(), r = ((Number) y).doubleValue();
            a = op.equals("+") ? l + r : op.equals("-") ? l - r : op.equals("*") ? l * r : op.equals("/") ? l / r : l % r; }
        }
      }
      Object unary() throws Exception {
        if (eat("!")) return !truthy(unary());
        if (eat("-")) { Object v = plain(unary()); if (v instanceof Double) return -(Double) v; if (v instanceof Number) return -((Number) v).longValue(); throw new IllegalArgumentException("- needs a number"); }
        return postfix(primary());
      }
      Object primary() throws Exception {
        String s = peek(); p++;
        if (s.isEmpty()) throw new IllegalArgumentException("the expression ends too early");
        if (s.equals("(")) { Object v = or(); if (!eat(")")) throw new IllegalArgumentException("missing )"); return v; }
        if (s.startsWith("\"")) return unquote(s.substring(1, s.length() - 1));
        if (s.startsWith("'")) return unquote(s.substring(1, s.length() - 1)).charAt(0);
        if (Character.isDigit(s.charAt(0))) { String n = s.replaceAll("[LlFfDd]$", ""); return n.contains(".") || s.matches(".*[FfDd]$") ? (Object) Double.parseDouble(n) : (Object) Long.parseLong(n); }
        if (s.equals("true") || s.equals("false")) return Boolean.parseBoolean(s);
        if (s.equals("null")) return null;
        StackFrame f = frame();
        if (s.equals("this")) return f.thisObject();
        LocalVariable lv = null;
        try { lv = f.visibleVariableByName(s); } catch (AbsentInformationException e) { /* no locals: try fields */ }
        if (lv != null) return f.getValue(lv);
        ObjectReference self = f.thisObject();
        ReferenceType type = self != null ? self.referenceType() : f.location().declaringType();
        Field fd = type.fieldByName(s);
        if (fd != null && (fd.isStatic() || self != null)) return fd.isStatic() ? type.getValue(fd) : self.getValue(fd);
        throw new IllegalArgumentException("no variable or field named " + s + " here");
      }
      Object postfix(Object v) throws Exception {
        for (;;) {
          if (eat(".")) {
            String name = peek(); p++;
            if (eat("(")) { if (!eat(")")) throw new IllegalArgumentException("only calls without arguments can be evaluated: " + name + "()");
              if (!(v instanceof ObjectReference)) throw new IllegalArgumentException("can't call " + name + "() on " + show(mirror(v)));
              v = invoke(t, (ObjectReference) v, name); continue; }
            if (v instanceof ArrayReference && name.equals("length")) { v = (long) ((ArrayReference) v).length(); continue; }
            if (!(v instanceof ObjectReference)) throw new IllegalArgumentException("can't read ." + name + " of " + show(mirror(v)));
            ObjectReference o = (ObjectReference) v;
            Field fd = o.referenceType().fieldByName(name);
            if (fd == null) throw new IllegalArgumentException(o.referenceType().name() + " has no field " + name);
            v = fd.isStatic() ? o.referenceType().getValue(fd) : o.getValue(fd);
          } else if (eat("[")) {
            Object i = plain(or());
            if (!eat("]")) throw new IllegalArgumentException("missing ]");
            if (!(v instanceof ArrayReference)) throw new IllegalArgumentException("[] needs an array");
            v = ((ArrayReference) v).getValue(((Number) i).intValue());
          } else return v;
        }
      }
      Object compare(Object a, Object b, String op) {
        Object x = plain(a), y = plain(b);
        if (x instanceof Number && y instanceof Number) {
          int c = Double.compare(((Number) x).doubleValue(), ((Number) y).doubleValue());
          switch (op) { case "==": return c == 0; case "!=": return c != 0; case "<": return c < 0; case ">": return c > 0; case "<=": return c <= 0; default: return c >= 0; }
        }
        boolean eq = Objects.equals(x, y);
        if (op.equals("==")) return eq;
        if (op.equals("!=")) return !eq;
        if (x instanceof String && y instanceof String) { int c = ((String) x).compareTo((String) y); return op.equals("<") ? c < 0 : op.equals(">") ? c > 0 : op.equals("<=") ? c <= 0 : c >= 0; }
        throw new IllegalArgumentException(op + " needs numbers or strings");
      }
      boolean truthy(Object v) { Object x = plain(v); if (x instanceof Boolean) return (Boolean) x; throw new IllegalArgumentException("&&, || and ! need true or false"); }
      // A JDI value as a plain Java one for arithmetic and comparisons (strings, boxed numbers and primitives).
      Object plain(Object v) {
        if (v instanceof StringReference) return ((StringReference) v).value();
        if (v instanceof ObjectReference) { Value b = boxed((ObjectReference) v); return b == null ? v : plain(b); }
        if (v instanceof BooleanValue) return ((BooleanValue) v).value();
        if (v instanceof CharValue) return ((CharValue) v).value();
        if (v instanceof DoubleValue || v instanceof FloatValue) return ((PrimitiveValue) v).doubleValue();
        if (v instanceof PrimitiveValue) return ((PrimitiveValue) v).longValue();
        if (v instanceof Integer) return ((Integer) v).longValue();
        return v;
      }
      Value mirror(Object v) {
        if (v == null || v instanceof Value) return (Value) v;
        if (v instanceof Boolean) return vm.mirrorOf((Boolean) v);
        if (v instanceof Long) return vm.mirrorOf((Long) v);
        if (v instanceof Double) return vm.mirrorOf((Double) v);
        if (v instanceof Character) return vm.mirrorOf((Character) v);
        return vm.mirrorOf(String.valueOf(v));
      }
    }
  }

  // ---------- builds ----------
  interface Logger { void log(String s); }
  static final class Build {
    final String kind; final Path dir, root, wrapper;
    Build(String k, Path d, Path r, Path w) { kind = k; dir = d; root = r; wrapper = w; }
    static final boolean WIN = System.getProperty("os.name").toLowerCase(Locale.ROOT).startsWith("windows");

    /** The Gradle or Maven build a file belongs to (the nearest build file above it), or null for a lone file. */
    static Build of(Path file) {
      for (Path d = file.getParent(); d != null; d = d.getParent()) {
        boolean gradle = Files.exists(d.resolve("build.gradle")) || Files.exists(d.resolve("build.gradle.kts")), maven = Files.exists(d.resolve("pom.xml"));
        if (!gradle && !maven) continue;
        String w = gradle ? (WIN ? "gradlew.bat" : "gradlew") : (WIN ? "mvnw.cmd" : "mvnw");
        for (Path r = d; r != null; r = r.getParent()) {
          if (Files.exists(r.resolve(w))) return new Build(gradle ? "gradle" : "maven", d, r, r.resolve(w));
          if (gradle && (Files.exists(r.resolve("settings.gradle")) || Files.exists(r.resolve("settings.gradle.kts")))) return new Build("gradle", d, r, null);
          if (maven && (r.getParent() == null || !Files.exists(r.getParent().resolve("pom.xml")))) return new Build("maven", d, r, null);
        }
        return new Build(gradle ? "gradle" : "maven", d, d, null);
      }
      return null;
    }

    /** Builds the project and returns the program's class path. */
    String classpath(Path work, Logger log) throws Exception {
      if (kind.equals("gradle")) {
        // An init script adds a task that prints the module's runtime class path after compiling it.
        Path init = work.resolve("qx-classpath.gradle");
        Files.write(init, List.of(
          "allprojects { p ->",
          "  p.afterEvaluate {",
          "    def ss = p.extensions.findByName('sourceSets')",
          "    if (ss != null && ss.findByName('main') != null && p.projectDir.canonicalPath == new File(gradle.startParameter.projectProperties['qxDir']).canonicalPath) {",
          "      def cp = ss.main.runtimeClasspath",
          "      p.tasks.register('qxClasspath') { dependsOn 'classes'; doLast { println 'QX_CP=' + cp.asPath } }",
          "    }",
          "  }",
          "}"), StandardCharsets.UTF_8);
        List<String> cmd = tool(wrapper, "gradle", root);
        cmd.addAll(List.of("-q", "--console=plain", "--no-configuration-cache", "-I", init.toString(), "-PqxDir=" + dir, "qxClasspath"));
        log.log("building with " + (wrapper != null ? wrapper.getFileName() : "gradle") + " (the first build can take a few minutes)");
        StringBuilder out = new StringBuilder();
        int code = runTool(cmd, root, l -> { if (l.startsWith("QX_CP=")) out.append(l.substring(6)); else log.log(l); });
        if (code != 0 || out.length() == 0) throw new IOException("the Gradle build failed (exit code " + code + "); fix the build, then debug again");
        return out.toString();
      }
      Path cpFile = work.resolve("cp.txt");
      List<String> cmd = tool(wrapper, "mvn", dir);
      boolean offline = Files.isDirectory(Paths.get(System.getProperty("user.home"), ".m2", "repository"));
      cmd.addAll(List.of("-q", "-B"));
      if (offline) cmd.add("-o");
      cmd.addAll(List.of("compile", "dependency:build-classpath", "-Dmdep.outputFile=" + cpFile, "-Dmdep.includeScope=runtime"));
      log.log("building with " + (wrapper != null ? wrapper.getFileName() : "mvn"));
      int code = runTool(cmd, dir, log::log);
      if (code != 0 && offline) { cmd.remove("-o"); log.log("the offline build failed; trying again online"); code = runTool(cmd, dir, log::log); }
      if (code != 0) throw new IOException("the Maven build failed (exit code " + code + "); fix the build, then debug again");
      String deps = Files.exists(cpFile) ? new String(Files.readAllBytes(cpFile), StandardCharsets.UTF_8).trim() : "";
      return dir.resolve("target").resolve("classes") + (deps.isEmpty() ? "" : File.pathSeparator + deps);
    }
  }

  // ---------- helpers ----------
  // A build tool's command: the project's wrapper, or the tool on PATH. On Windows a batch file runs through cmd,
  // which mangles a quoted program path, so the wrapper is named relative to the folder it runs in (gradlew.bat,
  // ..\mvnw.cmd: never a space in it).
  static List<String> tool(Path wrapper, String name, Path runIn) {
    if (!Build.WIN) return new ArrayList<>(wrapper == null ? List.of(name) : List.of("sh", wrapper.toString()));
    return new ArrayList<>(List.of("cmd.exe", "/d", "/c", wrapper == null ? name : runIn.relativize(wrapper).toString()));
  }
  static int runTool(List<String> cmd, Path dir, Logger each) throws Exception {
    Process p = new ProcessBuilder(cmd).directory(dir.toFile()).redirectErrorStream(true).start();
    p.getOutputStream().close();
    try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
      for (String l; (l = r.readLine()) != null; ) if (!l.isBlank()) each.log(l);
    }
    return p.waitFor();
  }
  // The program's output goes to this process's own (the debug job's log) and, as DAP output events, to the client.
  static void pump(InputStream from, PrintStream to, Adapter a, String category) {
    Thread t = new Thread(() -> {
      byte[] b = new byte[8192];
      try {
        for (int n; (n = from.read(b)) > 0; ) {
          to.write(b, 0, n); to.flush();
          a.event("output", obj("category", category, "output", new String(b, 0, n, StandardCharsets.UTF_8)));
        }
      } catch (IOException e) { /* ended */ }
    });
    t.setDaemon(true); t.start();
  }
  static String packageOf(Path file) {
    try {
      Matcher m = Pattern.compile("^\\s*package\\s+([\\w.]+)", Pattern.MULTILINE).matcher(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
      return m.find() ? m.group(1) : "";
    } catch (IOException e) { return ""; }
  }
  /** The folder a file's package starts in: src/main/java for src/main/java/com/x/App.java in package com.x. */
  static Path packageRoot(Path file) {
    Path r = file.getParent();
    String pkg = packageOf(file);
    if (!pkg.isEmpty()) for (int k = pkg.split("\\.").length; k > 0 && r.getParent() != null; k--) r = r.getParent();
    return r;
  }
  static String mainClass(Path file, String text) {
    Matcher pm = Pattern.compile("^\\s*package\\s+([\\w.]+)", Pattern.MULTILINE).matcher(text);
    String pkg = pm.find() ? pm.group(1) + "." : "";
    String stem = file.getFileName().toString().replaceAll("\\.(java|kt)$", "");
    if (!file.toString().endsWith(".kt")) return pkg + stem;
    Matcher jn = Pattern.compile("@file:JvmName\\(\"([\\w$]+)\"\\)").matcher(text);
    return pkg + (jn.find() ? jn.group(1) : Character.toUpperCase(stem.charAt(0)) + stem.substring(1) + "Kt");
  }
  static String unquote(String s) { return s.replace("\\n", "\n").replace("\\t", "\t").replace("\\\"", "\"").replace("\\'", "'").replace("\\\\", "\\"); }

  static Value invoke(ThreadReference t, ObjectReference o, String name) throws Exception {
    Method m = null;
    for (Method x : o.referenceType().methodsByName(name)) if (x.argumentTypeNames().isEmpty() && !x.isAbstract()) { m = x; break; }
    if (m == null) for (Method x : o.referenceType().allMethods()) if (x.name().equals(name) && x.argumentTypeNames().isEmpty() && !x.isAbstract()) { m = x; break; }
    if (m == null) throw new IllegalArgumentException(o.referenceType().name() + " has no method " + name + "() without arguments");
    return o.invokeMethod(t, m, List.of(), ObjectReference.INVOKE_SINGLE_THREADED);
  }

  /** The value inside a boxed Integer, Long, Boolean, or null when it isn't one. */
  static Value boxed(ObjectReference o) {
    String n = o.referenceType().name();
    if (!n.startsWith("java.lang.") || !List.of("Integer", "Long", "Short", "Byte", "Double", "Float", "Boolean", "Character").contains(n.substring(10))) return null;
    Field f = o.referenceType().fieldByName("value");
    return f == null ? null : o.getValue(f);
  }
  static String show(Value v) {
    if (v == null) return "null";
    if (v instanceof StringReference) { String s = ((StringReference) v).value(); return "\"" + (s.length() > 300 ? s.substring(0, 300) + "..." : s).replace("\"", "\\\"").replace("\n", "\\n") + "\""; }
    if (v instanceof CharValue) return "'" + ((CharValue) v).value() + "'";
    if (v instanceof PrimitiveValue) return v.toString();
    if (v instanceof ArrayReference) {
      ArrayReference a = (ArrayReference) v;
      StringJoiner j = new StringJoiner(", ", "{", a.length() > 10 ? ", ...}" : "}");
      for (Value x : a.getValues(0, Math.min(a.length(), 10))) j.add(show(x));
      String t = a.referenceType().name();
      return t.substring(t.lastIndexOf('.') + 1).replaceFirst("\\[\\]", "[" + a.length() + "]") + " " + j;
    }
    ObjectReference o = (ObjectReference) v;
    Value b = boxed(o);
    String t = o.referenceType().name();
    String simple = t.substring(t.lastIndexOf('.') + 1);
    return b != null ? simple + " " + show(b) : simple + " (id=" + o.uniqueID() + ")";
  }
}
