// QuorX desktop helper for macOS: reads and drives the windows of programs the agent started, through the
// Accessibility API (the structure VoiceOver reads), with a picture of a window as the fallback. QuorX builds it
// once with swiftc (Apple's Command Line Tools) and keeps the program in its data folder.
// Every request names the process ids it may touch (QuorX passes the agent job's processes); a window owned by any
// other process is refused, and keys go to the app's own process, so the user's own windows are never read or typed in.
// macOS asks once, for the app QuorX runs in (QuorX, or Terminal when started with npm start), for Accessibility
// (reading and pressing controls) and Screen Recording (pictures of a window).
// JSON lines on stdin/stdout, the same requests as uiahost.ps1 on Windows:
//   windows {pids}                       -> {windows: [{handle, pid, title}]}
//   tree    {pids, handle, depth, max}   -> {nodes: [{indent, role, name, value, checked, enabled, ref, x, y}], more}
//   click   {pids, handle, ref}          -> {did}
//   clickxy {pids, handle, x, y}         -> {did}
//   set     {pids, handle, ref, text}    -> {did}
//   keys    {pids, handle, events}       -> {did}   (events: [{text} | {code, mods}], made by server/deskkit.js)
//   shot    {pids, handle}               -> {png}   (base64)
//   close   {pids, handle}               -> {did}
//   trust   {prompt}                     -> {trusted, screen}
import Cocoa
import ApplicationServices

// The window number of an Accessibility window (the id screencapture and the window list use).
@_silgen_name("_AXUIElementGetWindow")
func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

struct Fail: Error { let message: String; init(_ m: String) { message = m } }

let notTrusted = "macOS has not allowed QuorX to use the Accessibility API yet. Open System Settings → Privacy & Security → Accessibility, turn on the app QuorX runs in (QuorX, or Terminal / iTerm when you started it with npm start), then try again. macOS only asks once."
let noScreen = "macOS has not allowed QuorX to take pictures of windows. Open System Settings → Privacy & Security → Screen Recording, turn on the app QuorX runs in, restart that app, then try again. Reading the window works without it."

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func text(_ el: AXUIElement, _ name: String) -> String? {
  let v = attr(el, name)
  if let s = v as? String { return s }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}
func element(_ v: AnyObject?) -> AXUIElement? {
  guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
  return (v as! AXUIElement)
}
func frame(_ el: AXUIElement) -> CGRect? {
  guard let p = attr(el, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
        let s = attr(el, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
  var pt = CGPoint.zero, sz = CGSize.zero
  guard AXValueGetValue(p as! AXValue, .cgPoint, &pt), AXValueGetValue(s as! AXValue, .cgSize, &sz) else { return nil }
  return CGRect(origin: pt, size: sz)
}
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func actions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
  return (names as? [String]) ?? []
}
func windowId(_ w: AXUIElement) -> Int? {
  var id: CGWindowID = 0
  return _AXUIElementGetWindow(w, &id) == .success && id != 0 ? Int(id) : nil
}

// Only processes with windows: the job also holds shells and the gate, which have no Accessibility tree.
func appWindows(_ pid: Int32) -> [AXUIElement] {
  guard NSRunningApplication(processIdentifier: pid) != nil else { return [] }
  return (attr(AXUIElementCreateApplication(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? []
}

// A window may be used only if a process the agent started owns it.
func window(_ handle: Int, _ pids: [Int32]) throws -> (AXUIElement, Int32) {
  for pid in pids { for w in appWindows(pid) where windowId(w) == handle { return (w, pid) } }
  if let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(handle)) as? [[String: Any]],
     let owner = info.first?[kCGWindowOwnerPID as String] as? Int32, !pids.contains(owner) {
    throw Fail("that window belongs to a program the agent did not start, so it is off limits")
  }
  throw Fail("that window is gone: list the windows again")
}

let interactive: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox",
  "AXMenuItem", "AXMenuButton", "AXLink", "AXSlider", "AXIncrementor", "AXRow", "AXCell", "AXDisclosureTriangle", "AXColorWell", "AXDateField"]
var refs: [Int: [AXUIElement]] = [:]

func walk(_ e: AXUIElement, _ indent: Int, _ level: Int, _ depth: Int, _ max: Int, _ origin: CGPoint, _ nodes: inout [[String: Any]], _ list: inout [AXUIElement]) {
  if nodes.count >= max || level > depth { return }
  let role = text(e, kAXRoleAttribute) ?? ""
  var name = text(e, kAXTitleAttribute) ?? ""
  if name.isEmpty { name = text(e, kAXDescriptionAttribute) ?? "" }
  if name.isEmpty, let label = element(attr(e, kAXTitleUIElementAttribute)) { name = text(label, kAXValueAttribute) ?? "" }
  if name.isEmpty { name = text(e, "AXPlaceholderValue") ?? "" }
  let enabled = (attr(e, kAXEnabledAttribute) as? Bool) ?? true
  var value: String? = nil
  var checked: Any? = nil
  if role == "AXCheckBox" || role == "AXRadioButton" {
    if let n = attr(e, kAXValueAttribute) as? NSNumber { checked = n.intValue == 1 ? true : n.intValue == 0 ? false : "mixed" }
  } else if role == "AXStaticText" && name.isEmpty {
    name = text(e, kAXValueAttribute) ?? ""
  } else if text(e, kAXSubroleAttribute) != "AXSecureTextField" {
    value = text(e, kAXValueAttribute)
  }
  let inter = enabled && (interactive.contains(role) || actions(e).contains(kAXPressAction))
  let show = inter || !name.isEmpty || level == 0 || !(value ?? "").isEmpty
  if show {
    var node: [String: Any] = ["indent": indent, "role": role, "name": String(name.prefix(200)), "enabled": enabled]
    if let v = value, !v.isEmpty { node["value"] = String(v.prefix(200)) }
    if let c = checked { node["checked"] = c }
    if inter {
      list.append(e)
      node["ref"] = list.count
      if let f = frame(e) { node["x"] = Int(f.midX - origin.x); node["y"] = Int(f.midY - origin.y) }
    }
    nodes.append(node)
  }
  for c in children(e) {
    if nodes.count >= max { break }
    walk(c, show ? indent + 1 : indent, level + 1, depth, max, origin, &nodes, &list)
  }
}

func control(_ handle: Int, _ r: Int) throws -> AXUIElement {
  guard let l = refs[handle], r >= 1, r <= l.count else { throw Fail("no control [\(r)] in this window: read it again (the numbers change when the window changes)") }
  return l[r - 1]
}

func bringToFront(_ w: AXUIElement, _ pid: Int32) {
  NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateIgnoringOtherApps])
  _ = AXUIElementPerformAction(w, kAXRaiseAction as CFString)
  usleep(200_000)
}

// The program whose window is on top at a point on the screen.
func ownerAt(_ p: CGPoint) -> Int32? {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
  for w in list {
    guard let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b as CFDictionary), r.contains(p) else { continue }
    if let a = w[kCGWindowAlpha as String] as? Double, a == 0 { continue }
    return w[kCGWindowOwnerPID as String] as? Int32
  }
  return nil
}

// A mouse click goes wherever the pointer is, so it is only sent when one of the agent's windows is on top there.
func mouseClick(_ p: CGPoint, _ pids: [Int32]) throws {
  guard let owner = ownerAt(p), pids.contains(owner) else { throw Fail("another window covers that point, so nothing was clicked: close it or click something else") }
  let src = CGEventSource(stateID: .hidSystemState)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(40_000)
  CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}

// Keys are posted to the app's own process, never to whatever happens to be in front.
func press(_ code: CGKeyCode, _ mods: [String], _ pid: Int32) {
  var flags = CGEventFlags()
  for m in mods {
    switch m {
    case "cmd": flags.insert(.maskCommand)
    case "ctrl": flags.insert(.maskControl)
    case "alt": flags.insert(.maskAlternate)
    case "shift": flags.insert(.maskShift)
    default: break
    }
  }
  let src = CGEventSource(stateID: .hidSystemState)
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down)
    e?.flags = flags
    e?.postToPid(pid_t(pid))
    usleep(12_000)
  }
}
func typeText(_ s: String, _ pid: Int32) {
  let src = CGEventSource(stateID: .hidSystemState)
  for ch in s {
    if ch == "\n" || ch == "\r" { press(36, [], pid); continue }
    let u = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      e?.postToPid(pid_t(pid))
    }
    usleep(8_000)
  }
}

func busy(_ r: AXError, _ did: String) throws -> String {
  if r == .success { return did }
  if r == .cannotComplete { return "\(did) (the app is still busy: it may have opened a dialog; list the windows)" }
  throw Fail("the app refused it (Accessibility error \(r.rawValue))")
}

func click(_ handle: Int, _ ref: Int, _ pids: [Int32]) throws -> String {
  let e = try control(handle, ref)
  let acts = actions(e)
  for a in [kAXPressAction, kAXConfirmAction, kAXPickAction] where acts.contains(a) {
    return try busy(AXUIElementPerformAction(e, a as CFString), "pressed")
  }
  guard let f = frame(e), f.width > 0, f.height > 0 else { throw Fail("that control has no place on screen to click") }
  let (w, pid) = try window(handle, pids)
  bringToFront(w, pid)
  try mouseClick(CGPoint(x: f.midX, y: f.midY), pids)
  return "clicked with the mouse (it has no button behaviour of its own)"
}

func clickAt(_ handle: Int, _ x: Int, _ y: Int, _ pids: [Int32]) throws -> String {
  let (w, pid) = try window(handle, pids)
  guard let f = frame(w) else { throw Fail("the window has no place on screen") }
  if x < 0 || y < 0 || CGFloat(x) >= f.width || CGFloat(y) >= f.height { throw Fail("that point is outside the window") }
  bringToFront(w, pid)
  try mouseClick(CGPoint(x: f.minX + CGFloat(x), y: f.minY + CGFloat(y)), pids)
  return "clicked at \(x),\(y)"
}

func setText(_ handle: Int, _ ref: Int, _ s: String, _ pids: [Int32]) throws -> String {
  let e = try control(handle, ref)
  var settable: DarwinBoolean = false
  if AXUIElementIsAttributeSettable(e, kAXValueAttribute as CFString, &settable) == .success, settable.boolValue {
    if AXUIElementSetAttributeValue(e, kAXValueAttribute as CFString, s as CFString) == .success { return "set its text" }
  }
  let (w, pid) = try window(handle, pids)
  bringToFront(w, pid)
  _ = AXUIElementSetAttributeValue(e, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  typeText(s, pid)
  return "typed into it"
}

func keys(_ handle: Int, _ events: [[String: Any]], _ pids: [Int32]) throws -> String {
  let (w, pid) = try window(handle, pids)
  bringToFront(w, pid)
  for e in events {
    if let t = e["text"] as? String { typeText(t, pid) }
    else if let c = e["code"] as? NSNumber { press(CGKeyCode(c.intValue), (e["mods"] as? [String]) ?? [], pid) }
  }
  return "sent the keys"
}

func shot(_ handle: Int) throws -> String {
  if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess(); throw Fail(noScreen) }
  let file = NSTemporaryDirectory() + "qx-shot-\(getpid())-\(handle).png"
  defer { try? FileManager.default.removeItem(atPath: file) }
  let p = Process()
  p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  p.arguments = ["-x", "-o", "-l", String(handle), file]
  try p.run()
  p.waitUntilExit()
  guard p.terminationStatus == 0, let d = FileManager.default.contents(atPath: file), d.count > 0 else { throw Fail("the window could not be pictured (it may be minimised)") }
  return d.base64EncodedString()
}

func closeWindow(_ handle: Int, _ pids: [Int32]) throws -> String {
  let (w, _) = try window(handle, pids)
  guard let b = element(attr(w, kAXCloseButtonAttribute)) else { throw Fail("that window can't be closed this way") }
  return try busy(AXUIElementPerformAction(b, kAXPressAction as CFString), "closed it")
}

func trusted(prompt: Bool) -> Bool {
  AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary)
}

func reply(_ obj: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return }
  FileHandle.standardOutput.write(d)
  FileHandle.standardOutput.write(Data("\n".utf8))
}

// An app that hangs answers no Accessibility call; give up on one after 3 seconds instead of waiting for ever.
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 3)
reply(["ready": true])
var prompted = false
while let line = readLine() {
  if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
  var id: Any = NSNull()
  do {
    guard let m = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { throw Fail("bad request") }
    id = m["id"] ?? NSNull()
    let op = m["op"] as? String ?? ""
    var out: [String: Any] = ["id": id, "ok": true]
    if op == "trust" {
      out["trusted"] = trusted(prompt: (m["prompt"] as? Bool) ?? false)
      out["screen"] = CGPreflightScreenCaptureAccess()
      reply(out)
      continue
    }
    // The first time, macOS shows its own prompt that leads to the setting.
    if !trusted(prompt: !prompted) { prompted = true; throw Fail(notTrusted) }
    let pids = ((m["pids"] as? [Any]) ?? []).compactMap { ($0 as? NSNumber)?.int32Value }
    let handle = (m["handle"] as? NSNumber)?.intValue ?? 0
    let ref = (m["ref"] as? NSNumber)?.intValue ?? 0
    if op != "windows" { _ = try window(handle, pids) }
    switch op {
    case "windows":
      var list: [[String: Any]] = []
      for pid in pids { for w in appWindows(pid) { if let h = windowId(w) { list.append(["handle": h, "pid": Int(pid), "title": text(w, kAXTitleAttribute) ?? ""]) } } }
      out["windows"] = list
    case "tree":
      let (w, _) = try window(handle, pids)
      let depth = (m["depth"] as? NSNumber)?.intValue ?? 25, max = (m["max"] as? NSNumber)?.intValue ?? 250
      var nodes: [[String: Any]] = [], list: [AXUIElement] = []
      walk(w, 0, 0, depth, max, frame(w)?.origin ?? .zero, &nodes, &list)
      refs[handle] = list
      out["nodes"] = nodes
      out["more"] = nodes.count >= max
    case "click": out["did"] = try click(handle, ref, pids)
    case "clickxy": out["did"] = try clickAt(handle, (m["x"] as? NSNumber)?.intValue ?? -1, (m["y"] as? NSNumber)?.intValue ?? -1, pids)
    case "set": out["did"] = try setText(handle, ref, m["text"] as? String ?? "", pids)
    case "keys": out["did"] = try keys(handle, (m["events"] as? [[String: Any]]) ?? [], pids)
    case "shot": out["png"] = try shot(handle)
    case "close": out["did"] = try closeWindow(handle, pids)
    default: throw Fail("unknown op \(op)")
    }
    reply(out)
  } catch let f as Fail {
    reply(["id": id, "ok": false, "error": f.message])
  } catch {
    reply(["id": id, "ok": false, "error": "\(error)"])
  }
}
