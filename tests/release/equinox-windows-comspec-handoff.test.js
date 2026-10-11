import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const handoffs=['ManagedUpdateHandoff.cs','MainUpdateHandoff.cs','ManagedUninstallHandoff.cs'];
for(const file of handoffs){
  test(`Windows ${file} restores OS-owned ComSpec after scrubbed updater environment`,async()=>{
    const body=await fs.readFile(path.join(root,'native/windows/EquinoxLocal.WindowsShell',file),'utf8');
    const cleared=body.indexOf('startInfo.Environment.Clear()');
    const comspec=body.indexOf('startInfo.Environment["ComSpec"] = Path.Combine(systemRoot, "System32", "cmd.exe");');
    assert.ok(cleared!==-1&&comspec>cleared,`${file} must restore trusted ComSpec after scrubbing all env`);
    assert.match(body,/startInfo\.Environment\["PATH"\]/u);
    assert.doesNotMatch(body,/CopyEnvironment\(startInfo, "ComSpec"\)/u);
  });
}
