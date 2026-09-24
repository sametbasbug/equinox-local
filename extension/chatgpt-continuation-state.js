(() => {
  const PUSH_TYPE = "equinox.chatgpt.continuationState.push";
  const GET_TYPE = "equinox.chatgpt.continuationState.get";
  const BROWSER_ENABLED_STORAGE_KEY = "browserEnabled";
  const BROWSER_CONTROL_CONSENT_STORAGE_KEY = "browserControlConsentVersion";
  const CURRENT_BROWSER_CONTROL_CONSENT_VERSION = 2;
  const PUBLISH_DEBOUNCE_MS = 100;

  const last = (values) => values.length ? values[values.length - 1] : null;

  function readState() {
    const userMessages = [...document.querySelectorAll('[data-message-author-role="user"][data-message-id]')];
    const assistantMessages = [...document.querySelectorAll('[data-message-author-role="assistant"][data-message-id]')];
    const userTurns = [...document.querySelectorAll('section[data-turn="user"][data-testid]')];
    const assistantTurns = [...document.querySelectorAll('section[data-turn="assistant"][data-testid]')];
    const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"]');
    return {
      generationActive: Boolean(document.querySelector('button[data-testid="stop-button"]')),
      userEpoch: last(userMessages)?.getAttribute('data-message-id') || last(userTurns)?.getAttribute('data-testid') || null,
      assistantTurnKey: last(assistantTurns)?.getAttribute('data-testid') || last(assistantMessages)?.getAttribute('data-message-id') || null,
      composerReady: Boolean(composer),
      composerEmpty: Boolean(composer) && !String(composer.textContent || '').trim(),
    };
  }

  let observer = null;
  let publishTimer = null;
  let lastSerializedState = null;
  let observationEnabled = false;

  function publishState({ force = false } = {}) {
    publishTimer = null;
    if (!observationEnabled) return;
    const state = readState();
    const serialized = JSON.stringify(state);
    if (!force && serialized === lastSerializedState) return;
    lastSerializedState = serialized;
    try {
      const pending = chrome.runtime.sendMessage({ type: PUSH_TYPE, state });
      pending?.catch?.(() => {});
    } catch {
      // Extension reload/unload races are harmless; the next observer tick or GET will refresh state.
    }
  }

  function schedulePublish() {
    if (!observationEnabled || publishTimer !== null) return;
    publishTimer = setTimeout(() => publishState(), PUBLISH_DEBOUNCE_MS);
  }

  function stopObservation() {
    observationEnabled = false;
    observer?.disconnect?.();
    observer = null;
    if (publishTimer !== null) clearTimeout(publishTimer);
    publishTimer = null;
    lastSerializedState = null;
  }

  function startObservation() {
    if (observationEnabled || !document.documentElement) return;
    observationEnabled = true;
    observer = new MutationObserver(schedulePublish);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["data-message-id", "data-testid", "disabled", "aria-disabled"],
    });
    publishState({ force: true });
  }

  async function refreshObservationAccess() {
    try {
      const stored = await chrome.storage.local.get([
        BROWSER_ENABLED_STORAGE_KEY,
        BROWSER_CONTROL_CONSENT_STORAGE_KEY,
      ]);
      const allowed = stored?.[BROWSER_ENABLED_STORAGE_KEY] === true
        && Number(stored?.[BROWSER_CONTROL_CONSENT_STORAGE_KEY] || 0) >= CURRENT_BROWSER_CONTROL_CONSENT_VERSION;
      if (allowed) startObservation();
      else stopObservation();
    } catch {
      stopObservation();
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== GET_TYPE) return false;
    sendResponse({ state: observationEnabled ? readState() : null });
    return false;
  });

  chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes?.[BROWSER_ENABLED_STORAGE_KEY] && !changes?.[BROWSER_CONTROL_CONSENT_STORAGE_KEY]) return;
    void refreshObservationAccess();
  });

  if (document.documentElement) void refreshObservationAccess();
  else document.addEventListener("DOMContentLoaded", () => { void refreshObservationAccess(); }, { once: true });
})();
