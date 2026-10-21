import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const source = readFileSync(fileURLToPath(new URL('../../extension/popup.js', import.meta.url)), 'utf8');

function createPopupHarness(initial) {
  const elements = new Map();
  const messages = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', textContent: '', checked: false, disabled: false, hidden: false,
      listeners: new Map(), children: [],
      classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      append(child) { this.children.push(child); },
      replaceChildren() { this.children = []; },
      blur() {},
    });
    return elements.get(id);
  };
  let state = initial;
  const sandbox = {
    chrome: { runtime: { sendMessage(message, callback) {
      messages.push(message);
      if (message.type === 'equinox.popup.openAgentBrowser') callback({ ok: true, result: { opened: true } });
      else {
        if (message.type === 'equinox.popup.acceptBrowserControlConsent') state = { ...state, consentAccepted: true, enabled: true };
        if (message.type === 'equinox.popup.setAutoContinueTarget') state = {
          ...state, autoContinue: { ...state.autoContinue, target: { mode: message.mode, tabId: message.tabId } },
        };
        callback({ ok: true, result: state });
      }
    } } },
    document: { querySelector(selector) { return element(selector.slice(1)); }, createElement() { return element(`new-${elements.size}`); }, activeElement: null },
    window: { addEventListener() {} },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout(callback) { return { callback }; }, clearTimeout() {},
  };
  vm.runInNewContext(source, sandbox, { filename: 'popup.js' });
  const fire = async (id, event) => {
    element(id).listeners.get(event)();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  };
  return { element, fire, messages };
}

test('TypeScript-generated classic popup requires consent and pins Auto Continue to selected task tab', async () => {
  const harness = createPopupHarness({
    consentAccepted: false, enabled: false, agentCursorEnabled: false, localConnected: true,
    browserContext: 'user',
    autoContinue: { target: { mode: 'task-tab' }, tabs: [{ tabId: 17, title: 'Bound task' }] },
  });
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  assert.equal(harness.element('enabled-toggle').disabled, true);
  assert.equal(harness.element('consent-card').hidden, false);
  assert.equal(harness.messages[0].type, 'equinox.popup.status');
  await harness.fire('accept-consent', 'click');
  assert.equal(harness.element('enabled-toggle').disabled, false);
  assert.equal(harness.element('consent-card').hidden, true);
  harness.element('auto-continue-target').value = 'pinned:17';
  await harness.fire('auto-continue-target', 'change');
  assert.equal(harness.messages.at(-1).type, 'equinox.popup.setAutoContinueTarget');
  assert.equal(harness.messages.at(-1).mode, 'pinned');
  assert.equal(harness.messages.at(-1).tabId, 17);
  await harness.fire('open-agent-browser', 'click');
  assert.ok(harness.messages.some((message) => message.type === 'equinox.popup.openAgentBrowser'));
  assert.equal(harness.element('agent-browser-feedback').textContent, 'Agent Browser opened.');
});
