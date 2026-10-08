import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const browser = readFileSync(new URL("../../extension/service-worker.js", import.meta.url), "utf8");
const telegram = readFileSync(new URL("../../src/telegram-chat-bridge-controller.js", import.meta.url), "utf8");
const observer = readFileSync(new URL("../../extension/chatgpt-continuation-state.js", import.meta.url), "utf8");
const modernSend = '[data-composer-body] button.bg-composer-primary[type="submit"]';

test("Telegram new Task, Fresh Chat Resume and Chat Bridge trust the modern composer submit control", () => {
  // Verified on a live, authenticated 2026-10 ChatGPT root page: no data-testid,
  // submit button appears with aria-label Gönder only after typing. Voice/Stop
  // controls may share bg-composer-primary but have type=button, not submit.
  assert.ok(telegram.includes(modernSend), "Telegram new Task must use the new ChatGPT send control");
  assert.ok(browser.includes(modernSend), "Fresh Chat Resume and Chat Bridge must share the same new send control");
  assert.match(browser, /const chatBridgeSendSelector = CHATGPT_SEND_SELECTOR;/u);
  assert.match(browser, /const button = document.querySelector\(\$\{JSON\.stringify\(CHATGPT_SEND_SELECTOR\)\}\);/u);
  assert.match(browser, /await clickSelectorWithActionability\(\s*created\.id,\s*CHATGPT_SEND_SELECTOR/u);
  assert.match(browser, /await clickSelectorWithActionability\(tabId, chatBridgeSendSelector/u);
});

test("Chat Bridge and Auto Continue share modern turn identity rather than removed legacy selectors", () => {
  const bridgeReader = browser.slice(browser.indexOf("async function readChatBridgeAttachedState("), browser.indexOf("async function inspectChatBridgeState("));
  assert.match(bridgeReader, /await chatGptContinuationState\(tabId\)/u);
  assert.doesNotMatch(bridgeReader, /document\.querySelectorAll\(/u);
  assert.match(observer, /\[data-turn-key\]/u);
  assert.match(observer, /\[data-chatgpt-search-unit-key/u);
  assert.match(observer, /\[data-composer-body\] button\.bg-composer-primary/u);
  assert.match(browser, /const turns = document.querySelectorAll\('\[data-message-author-role\], section\[data-turn\], \[data-turn-key\]'\)/u);
});


test("Chat Bridge final response reads the exact modern assistant message inside the observed data-turn-key", () => {
  const responseReader = browser.slice(browser.indexOf("async function readChatBridgeFinalResponse("), browser.indexOf("function clearReconnectSchedule("));
  assert.match(responseReader, /document\.querySelectorAll\('\[data-turn-key\]'\)/u);
  assert.match(responseReader, /getAttribute\('data-turn-key'\) === key/u);
  assert.match(responseReader, /modernTurn\?\.querySelector\('\[data-chatgpt-search-unit-key\$=":assistant"\]\[data-chatgpt-search-message-ids\]'\)/u);
  assert.match(responseReader, /modernAssistant\.querySelector\('\[data-chatgpt-selection-message-id\]'\)/u);
  assert.match(responseReader, /if \(!root\) return \{ found: false \}/u);
});


test("Fresh Chat Resume rejects a non-empty modern turn before submission", () => {
  const reader = browser.slice(browser.indexOf("async function freshChatComposerState("), browser.indexOf("async function waitForFreshChatHome("));
  assert.match(reader, /const modernTurns = document\.querySelectorAll\('\[data-turn-key\]'\)/u);
  assert.match(reader, /userTurnCount: userTurns\.length \+ modernTurns\.length/u);
  assert.match(browser, /if \(state\.userTurnCount \|\| state\.assistantTurnCount\) throw new Error\("Fresh Chat Resume destination is not an empty conversation\."\)/u);
});
