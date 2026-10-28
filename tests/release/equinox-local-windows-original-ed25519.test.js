import assert from "node:assert/strict";
import {createPublicKey,generateKeyPairSync} from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";
import {EQUINOX_LOCAL_UPDATE_KEYS} from "../../src/equinox-local-update-keys.js";
import {
 canonicalMainInstallPointerPayload,createSignedMainInstallPointer,
 validateSignedMainInstallPointer,
} from "../../src/equinox-local-main-install-pointer.js";

const guardian = new URL("../../native/windows/EquinoxLocal.Guardian/MainOriginalProductionSignature.cs",import.meta.url);
const audit = new URL("../../native/windows/EquinoxLocal.Guardian/MainNativeSignedJournalAudit.cs",import.meta.url);
const project = new URL("../../native/windows/EquinoxLocal.Guardian/EquinoxLocal.Guardian.csproj",import.meta.url);
const keys=Object.keys(EQUINOX_LOCAL_UPDATE_KEYS);
const targets=["darwin-arm64","darwin-x64","win32-arm64","win32-x64"];
const SHA="b".repeat(40),CONTRACT="c".repeat(64),DIGEST="d".repeat(64);
function fixture(){
 const {publicKey,privateKey}=generateKeyPairSync("ed25519");
 const keyId="only-local-unit-test-ed25519";
 const signed=createSignedMainInstallPointer({
  sourceSha:SHA,version:"6.2.0",publishedAt:"2026-10-28T01:00:00.000Z",
  keyId,privateKey,nativeManifests:targets.map(target=>({
    schemaVersion:1,channel:"main",sourceSha:SHA,target,
    runtimeContractSha256:CONTRACT,
    artifact:{name:"equinox-local-main-"+SHA+"-"+target+
      (target.startsWith("win32")?".zip":".tar.gz"),sha256:DIGEST,bytes:2048},
  })),
 });
 const publicKeys={[keyId]:publicKey.export({type:"spki",format:"pem"})};
 return {signed,publicKeys};
}

test("original Guardian binds EXACT same pinned production Ed25519 SPKI key and key ID as shipped Node updater, without any private key",async()=>{
 const code=await fs.readFile(guardian,"utf8");
 assert.deepEqual(keys,["stable-2026-01"],"rotation must add both roots deliberately");
 const originalKey=createPublicKey(EQUINOX_LOCAL_UPDATE_KEYS[keys[0]])
   .export({type:"spki",format:"der"}).subarray(12).toString("base64");
 assert.equal(Buffer.from(originalKey,"base64").length,32);
 assert.match(code,/private const string OriginalMainKeyId = "stable-2026-01"/u);
 assert.ok(code.includes('private const string OriginalMainPublicKey = "'+originalKey+'"'));
 assert.doesNotMatch(code,/BEGIN PRIVATE KEY|PRIVATE KEY|privateKey|SigningPrivate|ECDsa\.Verify/u);
 assert.match(code,/new Ed25519PublicKeyParameters\(key, 0\)/u);
 assert.match(code,/verifier\.VerifySignature\(signature\)/u);
 assert.match(code,/throw new InvalidDataException\("Original Main Ed25519 production signature verification failed\."\)/u);
});

test("original Guardian is the crypto owner: pinned audited NuGet library, no arbitrary Node/PowerShell handoff for signature validation",async()=>{
 const [source,csproj,guard]=await Promise.all([
  fs.readFile(guardian,"utf8"),fs.readFile(project,"utf8"),fs.readFile(audit,"utf8"),
 ]);
 assert.match(csproj,/<PackageReference Include="BouncyCastle\.Cryptography" Version="2\.7\.0" \/>/u);
 assert.match(source,/using Org\.BouncyCastle\.Crypto\.Signers;/u);
 assert.match(source,/new Ed25519Signer\(\)/u);
 assert.match(source,/JavaScriptEncoder\.UnsafeRelaxedJsonEscaping/u);
 assert.match(source,/RequireExactKeys\(pointer, \["schemaVersion", "channel", "sourceSha", "version",/u);
 assert.match(source,/RequireExactKeys\(sig, \["algorithm", "keyId", "value"\]\)/u);
 assert.match(source,/signature\.Length != 64/u);
 assert.match(source,/Convert\.ToBase64String\(signature\) != signatureBase64/u);
 assert.match(source,/writer\.WriteNumber\("schemaVersion", 1\)/u);
 assert.match(source,/writer\.WritePropertyName\("targets"\)/u);
 assert.match(source,/writer\.WritePropertyName\("artifact"\)/u);
 assert.match(source,/MainSnapshotsBase \+ expectedSourceSha \+ "\/" \+ archive/u);
 assert.match(source,/target != MainTargets\[i\]/u);
 assert.match(source,/published\.ToString\("yyyy-MM-dd'T'HH:mm:ss\.fff'Z'"/u);
 assert.doesNotMatch(source,/Process\.Start|powershell\.exe|cmd\.exe|File\.WriteAllText/u);
 assert.match(guard,/VerifyOriginalSignedNativeMainSelector\(Path\.Combine\(/u);
 assert.match(guard,/signed\.ArtifactSha256 != store\.GetProperty\("artifactSha256"\)\.GetString\(\)/u);
 assert.match(guard,/signed\.ArtifactBytes != store\.GetProperty\("artifactBytes"\)\.GetInt64\(\)/u);
 assert.match(guard,/signed\.Contract != contract/u);
 assert.match(guard,/metadata\.GetProperty\("sourceSha"\)\.GetString\(\) != sha/u);
 assert.match(guard,/metadata\.GetProperty\("version"\)\.GetString\(\) != signed\.Version/u);
 assert.match(guard,/metadata\.GetProperty\("serverEntry"\)\.GetString\(\) != "server\.js"/u);
 assert.match(guard,/FingerprintNativeMainRelease\(expected\.ReleaseDir\)/u);
 assert.match(guard,/original signed Main B full executable release fingerprint/i);
 assert.match(guard,/signed-native-ed25519-verified-journal-read-only-incomplete/u);
 assert.doesNotMatch(guard,/HoldOwnedNativeJournalLease|SwitchNative|RegisterWindowsNativeMessaging|Process\.Kill/u);
});

test("cross-language canonical Main Ed25519 contract rejects forged or altered SHA/target/version/hash/bytes/key/signature with ephemeral test signer",()=>{
 const {signed,publicKeys}=fixture();
 assert.equal(signed.targets.length,4);
 assert.deepEqual(signed.targets.map(item=>item.target),targets);
 assert.equal(validateSignedMainInstallPointer(signed,{publicKeys,expectedSourceSha:SHA}).sourceSha,SHA);
 const {signature:ignoredSignature,...signedPayload}=signed;
 const canonical=canonicalMainInstallPointerPayload(signedPayload);
 assert.equal(canonical,JSON.stringify({
  schemaVersion:1,channel:"main",sourceSha:SHA,
  version:"6.2.0",publishedAt:"2026-10-28T01:00:00.000Z",
  targets:signed.targets,
 }));
 assert.equal(Object.keys(signed.targets[0]).join(","),"target,runtimeContractSha256,artifact");
 assert.equal(Object.keys(signed.targets[0].artifact).join(","),"url,sha256,bytes");
 assert.deepEqual(Object.keys(signed.signature),["algorithm","keyId","value"]);
 const altered=[
  {...signed,sourceSha:"a".repeat(40)},
  {...signed,version:"6.2.1"},
  {...signed,targets:[...signed.targets].reverse()},
  {...signed,targets:signed.targets.map((item,i)=>i===2
   ? {...item,runtimeContractSha256:"f".repeat(64)}:item)},
  {...signed,targets:signed.targets.map((item,i)=>i===2
   ? {...item,artifact:{...item.artifact,sha256:"f".repeat(64)}}:item)},
  {...signed,targets:signed.targets.map((item,i)=>i===2
   ? {...item,artifact:{...item.artifact,bytes:2049}}:item)},
  {...signed,signature:{...signed.signature,value:Buffer.alloc(64).toString("base64")}},
  {...signed,signature:{...signed.signature,keyId:"foreign"}},
  {...signed,signature:{...signed.signature,algorithm:"rsa"}},
 ];
 for(const value of altered)assert.throws(()=>validateSignedMainInstallPointer(
  value,{publicKeys,expectedSourceSha:SHA}));
});

test("production signer unit tests NEVER store signing secrets or claim native Guardian host acceptance",async()=>{
 const source=await fs.readFile(guardian,"utf8");
 assert.ok(source.includes("read-only")||source.includes("READ-ONLY"));
 assert.match(source,/signed-native-original-ed25519-verified-read-only/u);
 const native=await fs.readFile(audit,"utf8");
 assert.match(native,/OS HMAC\/journal authority or healthy B/u);
 assert.doesNotMatch(native,/File\.WriteAllText|Process\.Start/u);
});
