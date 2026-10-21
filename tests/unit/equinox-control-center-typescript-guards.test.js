import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";

const js=readFileSync(new URL("../../src/equinox-control-center.js",import.meta.url),"utf8");
const between=(from,to)=>{
  const start=js.indexOf(from);
  const end=js.indexOf(to,start+from.length);
  assert.ok(start>=0&&end>start,"missing fixed UI procedure boundary: "+from);
  return js.slice(start,end);
};

test("Control Center renders untrusted Task/doctor/service strings only through text nodes, never executable HTML",()=>{
  assert.doesNotMatch(js,/\.(?:innerHTML|outerHTML)\s*=|\.insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new Function\s*\(/u);
  const task=between("function renderTasks()","async function selectTask(");
  assert.match(task,/title\.textContent = task\.title/u);
  assert.match(task,/taskId\.textContent = task\.taskId/u);
  const doctor=between("function renderDoctor()","function shortUpdateSha(");
  assert.match(doctor,/detail\.textContent = localizeDoctorDetail\(item\)/u);
  assert.match(js,/element\.textContent = localizeUiText\(value \?\? "—"\)/u);
});

test("Control Center mutations obtain fixed-origin CSRF token before using JSON body, never omit same-origin credentials",()=>{
  const request=between("async function requestJson(","async function mutationJson(");
  assert.match(request,/cache: "no-store"/u);
  assert.match(request,/credentials: "same-origin"/u);
  const mutation=between("async function mutationJson(","function showError(");
  assert.match(mutation,/await requestJson\("\/api\/v1\/session"\)/u);
  assert.match(mutation,/"x-equinox-csrf": session\.csrfToken/u);
  assert.match(mutation,/body: JSON\.stringify\(body\)/u);
  assert.doesNotMatch(mutation,/localStorage|document\.cookie|fetch\s*\(/u);
});

test("Control Center user and agent browser controls keep distinct contexts without implicit personal-browser activation",()=>{
  const status=between("function browserContextStatus(","function browserSettingsFromStatus(");
  assert.match(status,/browser\.contexts\?\.\[target\]/u);
  assert.match(status,/if \(target !== "user"\)\s+return \{\}/u);
  const selection=between("function selectBrowserSettingsTarget(","function updateBrowserDraftFromInputs(");
  assert.match(selection,/\["agent", "user"\]\.includes\(value\)/u);
  const open=between("async function openAgentBrowserFromControlCenter(","async function saveBrowserSettings(");
  assert.match(open,/mutationJson\("\/api\/v1\/browser\/agent\/open", "POST", \{\}\)/u);
  const settings=between("async function saveBrowserSettings(","async function startTelegramPairingUi(");
  assert.match(settings,/const target = state\.browserDraft\.context/u);
  assert.match(settings,/mutationJson\("\/api\/v1\/browser\/settings", "PUT", state\.browserDraft\)/u);
  assert.doesNotMatch(settings,/\/api\/v1\/browser\/agent\/open|\/api\/v1\/browser\/user\/open/u);
});

test("native folder-picker messages require matching operation type and request nonce before trusting returned path",()=>{
  const picker=between("async function pickLocalFolder(","function normalizeTheme(");
  assert.match(picker,/crypto\.randomUUID/u);
  assert.match(picker,/message\?\.type !== "equinox-folder-picker-result"/u);
  assert.match(picker,/message\.requestId !== requestId/u);
  assert.match(picker,/bridge\.removeEventListener\("message", onMessage\)/u);
  assert.match(picker,/mutationJson\("\/api\/v1\/folder-picker", "POST", \{\}\)/u);
  assert.doesNotMatch(picker,/document\.write|innerHTML/u);
});
