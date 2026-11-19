import AppKit
import ApplicationServices
let args=CommandLine.arguments
func reply(_ value:[String:Any]) { if let data=try? JSONSerialization.data(withJSONObject:value),let text=String(data:data,encoding:.utf8){print(text)} }
let mode=args.count>1 ? args[1] : "status"
if mode=="frontmost" { reply(["pid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0]);exit(0) }
if mode=="authorize" { let key=kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String;reply(["trusted":AXIsProcessTrustedWithOptions([key:true] as CFDictionary)]);exit(0) }
if mode=="status" {reply(["trusted":AXIsProcessTrusted()]);exit(0)}
if (mode=="copy" || mode=="insert") && args.count>2 {
 let url=URL(fileURLWithPath:args[2]);guard FileManager.default.fileExists(atPath:url.path) else {reply(["error":"File missing"]);exit(1)}
 NSPasteboard.general.clearContents();let copied=NSPasteboard.general.writeObjects([url as NSURL]);
 if mode=="insert",args.count>3,let pid=Int32(args[3]),pid>0,let target=NSRunningApplication(processIdentifier:pid){target.activate(options:[.activateIgnoringOtherApps]);usleep(300000);if AXIsProcessTrusted(),let down=CGEvent(keyboardEventSource:nil,virtualKey:9,keyDown:true),let up=CGEvent(keyboardEventSource:nil,virtualKey:9,keyDown:false){down.flags = .maskCommand;up.flags = .maskCommand;down.post(tap:.cghidEventTap);up.post(tap:.cghidEventTap);reply(["copied":copied,"pasted":true]);exit(0)}}
 reply(["copied":copied,"pasted":false,"trusted":AXIsProcessTrusted()]);exit(0)
}
reply(["error":"Invalid command"]);exit(1)
