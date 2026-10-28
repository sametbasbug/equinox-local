import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const locator=new URL("../../native/windows/EquinoxLocal.WindowsShell/WindowsManagedSourceRuntimeLocator.cs",import.meta.url);
const handoff=new URL("../../native/windows/EquinoxLocal.WindowsShell/MainUpdateHandoff.cs",import.meta.url);
const guardian=new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeWorkerArguments.cs",import.meta.url);

test("original Windows WPF cannot silently claim stale Stable A when committed Git-free native Main SHA pointer exists",async()=>{
 const source=await fs.readFile(locator,"utf8");
 const section=source.slice(source.indexOf('if (!File.Exists(installStampPath))'),
  source.indexOf('RequireNormalDirectory(transactionRoot, "Main update state directory")'));
 assert.match(section,/var candidateNativePointerPath = Path.Combine\(transactionRoot, "current-native.json"\)/u);
 assert.match(section,/Directory\.EnumerateFileSystemEntries\(transactionRoot, "current-native\.json"/u);
 assert.match(section,/if \(nativePointerPresent\)/u);
 assert.doesNotMatch(section,/if \(File\.Exists\(nativePointerPath\)\)/u);
 assert.match(section,/ResolveNativeRelease\(transactionRoot, candidateNativePointerPath\)/u);
 assert.match(section,/production Ed25519 and independent Guardian admission/u);
 assert.ok(section.indexOf("nativePointerPresent")<
   section.indexOf("WindowsManagedReleaseLocator.ResolveCurrentRelease()"));
 assert.match(source,/RequireExactProperties\(pointer, \["schemaVersion", "channel", "sourceSha", "target", "runtimeContractSha256"\]/u);
});

test("original signed Windows native OS Guardian strictly enforces exact source-only worker argv; B native cannot spoof Git mode",async()=>{
 const [wpf,osOwner]=await Promise.all([fs.readFile(handoff,"utf8"),fs.readFile(guardian,"utf8")]);
 assert.match(wpf,/ValidateInstallStamp\(Path.Combine\(transactionRoot, "install.json"\)\)/u);
 assert.match(wpf,/RequireExactSourceRoot\(receipt, "rollbackSourceRoot", sourcesRoot, currentSha\)/u);
 assert.match(wpf,/RequireExactSourceRoot\(receipt, "targetSourceRoot", sourcesRoot, targetSha\)/u);
 assert.match(wpf,/MainUpdateHandoff/u);
 assert.match(osOwner,/InspectOwnedNativeWorkerOsArguments/u);
 assert.match(osOwner,/ReadOsProcessCommandLine\(process\)/u);
 assert.match(osOwner,/arguments.Length != expected.Length/u);
 assert.match(osOwner,/arguments\[i\], expected\[i\]/u);
 assert.match(osOwner,/Windows worker OS process argv differs from its exact Main transaction contract/u);
});
