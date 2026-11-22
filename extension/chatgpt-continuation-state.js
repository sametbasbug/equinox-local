"use strict";
(() => {
    const PUSH_TYPE = "equinox.chatgpt.continuationState.push";
    const GET_TYPE = "equinox.chatgpt.continuationState.get";
    const BROWSER_ENABLED_STORAGE_KEY = "browserEnabled";
    const BROWSER_CONTROL_CONSENT_STORAGE_KEY = "browserControlConsentVersion";
    const CURRENT_BROWSER_CONTROL_CONSENT_VERSION = 2;
    const PUBLISH_DEBOUNCE_MS = 100;
    const last = (values) => values.length ? values[values.length - 1] : null;
    function firstMessageId(value) {
        const text = String(value || "").trim();
        return text ? text.split(/\s+/u)[0].slice(0, 200) : null;
    }
    function isVisibleComposerAction(button) {
        if (!button.isConnected || !button.getClientRects().length)
            return false;
        const rect = button.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0)
            return false;
        const style = window.getComputedStyle(button);
        return style.visibility !== "hidden" && style.display !== "none";
    }
    function looksLikeModernStopAction(button) {
        if (!button?.querySelector)
            return false;
        const svg = button.querySelector('svg[viewBox="0 0 20 20"]');
        const path = svg?.querySelector?.('path');
        if (!path || typeof path.getBBox !== "function")
            return false;
        try {
            const box = path.getBBox();
            return box.x >= 4 && box.x <= 5.5
                && box.y >= 4 && box.y <= 5.5
                && box.width >= 10 && box.width <= 12
                && box.height >= 10 && box.height <= 12
                && Math.abs(box.width - box.height) <= 1;
        }
        catch {
            return false;
        }
    }
    // Timestamp belongs to the Browser's actual generation transition,
    // not to the first later Equinox Local RPC (which can be minutes later).
    let activeGeneration = null;
    function readState() {
        const userMessages = [...document.querySelectorAll('[data-message-author-role="user"][data-message-id]')];
        const assistantMessages = [...document.querySelectorAll('[data-message-author-role="assistant"][data-message-id]')];
        const userTurns = [...document.querySelectorAll('section[data-turn="user"][data-testid]')];
        const assistantTurns = [...document.querySelectorAll('section[data-turn="assistant"][data-testid]')];
        const modernTurns = [...document.querySelectorAll('[data-turn-key]')];
        const modernUserUnits = [...document.querySelectorAll('[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]')];
        // Reject hidden or ambiguous editors; only the single visible composer
        // authorizes Chat Bridge or Auto Continue delivery.
        const visibleComposers = [...document.querySelectorAll('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]')]
            .filter(node => {
            const rect = node.getBoundingClientRect();
            const style = window.getComputedStyle(node);
            return node.isConnected && node.getClientRects().length > 0
                && rect.width > 0 && rect.height > 0
                && style.visibility !== 'hidden' && style.display !== 'none';
        });
        const composer = visibleComposers.length === 1 ? visibleComposers[0] : null;
        // ChatGPT can retain an invisible, stale Stop control alongside the
        // currently visible voice/Send control after a response is complete.
        const modernPrimaryActions = [...document.querySelectorAll('[data-composer-body] button.bg-composer-primary')]
            .filter(isVisibleComposerAction);
        const modernGenerationActive = modernPrimaryActions.some(looksLikeModernStopAction);
        const modernTurn = last(modernTurns);
        const modernTurnKey = firstMessageId(modernTurn?.getAttribute('data-turn-key'));
        const modernUserEpoch = modernTurnKey
            || firstMessageId(last(modernUserUnits)?.getAttribute('data-chatgpt-search-message-ids'));
        const modernAssistantUnits = modernTurn?.querySelectorAll
            ? [...modernTurn.querySelectorAll('[data-chatgpt-search-unit-key$=":assistant"][data-chatgpt-search-message-ids]')]
            : [];
        const modernAssistantTurnKey = firstMessageId(last(modernAssistantUnits)?.getAttribute('data-chatgpt-search-message-ids'));
        const result = {
            generationActive: [...document.querySelectorAll('button[data-testid="stop-button"]')].some(isVisibleComposerAction) || modernGenerationActive,
            userEpoch: modernTurnKey
                || last(userMessages)?.getAttribute('data-message-id')
                || last(userTurns)?.getAttribute('data-testid')
                || modernUserEpoch
                || null,
            assistantTurnKey: modernTurnKey
                || last(assistantTurns)?.getAttribute('data-testid')
                || last(assistantMessages)?.getAttribute('data-message-id')
                || modernAssistantTurnKey
                || null,
            composerReady: Boolean(composer),
            // A selected file is unsent human input even if ProseMirror text is empty.
            // The modern provider uses attachment cards without data-testid.
            composerEmpty: composer !== null && !String(composer.textContent || '').trim()
                && !composer.closest('form')?.querySelector('span[class*="group/composer-attachment"],[data-testid*="attachment-preview"],[data-testid*="file-chip"],[data-testid*="image-preview"]'),
        };
        const key = result.userEpoch || result.assistantTurnKey;
        if (!result.generationActive || !key)
            activeGeneration = null;
        else if (!activeGeneration || activeGeneration.key !== key) {
            activeGeneration = { key, startedAtMs: Date.now() };
        }
        return { ...result, generationStartedAtMs: activeGeneration?.startedAtMs ?? null };
    }
    let observer = null;
    let publishTimer = null;
    let lastSerializedState = null;
    let observationEnabled = false;
    function publishState({ force = false } = {}) {
        publishTimer = null;
        if (!observationEnabled)
            return;
        const state = readState();
        const serialized = JSON.stringify(state);
        if (!force && serialized === lastSerializedState)
            return;
        lastSerializedState = serialized;
        try {
            const pending = chrome.runtime.sendMessage({ type: PUSH_TYPE, state });
            pending?.catch?.(() => { });
        }
        catch {
            // Extension reload/unload races are harmless; the next observer tick or GET will refresh state.
        }
    }
    function schedulePublish() {
        if (!observationEnabled || publishTimer !== null)
            return;
        publishTimer = setTimeout(() => publishState(), PUBLISH_DEBOUNCE_MS);
    }
    function stopObservation() {
        observationEnabled = false;
        observer?.disconnect?.();
        observer = null;
        if (publishTimer !== null)
            clearTimeout(publishTimer);
        publishTimer = null;
        lastSerializedState = null;
    }
    function startObservation() {
        if (observationEnabled || !document.documentElement)
            return;
        observationEnabled = true;
        observer = new MutationObserver(schedulePublish);
        observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
            attributeFilter: [
                "data-message-id", "data-testid", "data-turn-key",
                "data-chatgpt-search-message-ids", "data-chatgpt-search-unit-key",
                "data-content-search-unit-key", "data-composer-markdown",
                "disabled", "aria-disabled",
            ],
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
            if (allowed)
                startObservation();
            else
                stopObservation();
        }
        catch {
            stopObservation();
        }
    }
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.type !== GET_TYPE)
            return false;
        sendResponse({ state: observationEnabled ? readState() : null });
        return false;
    });
    chrome.storage.onChanged?.addListener((changes, areaName) => {
        if (areaName !== "local")
            return;
        if (!changes?.[BROWSER_ENABLED_STORAGE_KEY] && !changes?.[BROWSER_CONTROL_CONSENT_STORAGE_KEY])
            return;
        void refreshObservationAccess();
    });
    if (document.documentElement)
        void refreshObservationAccess();
    else
        document.addEventListener("DOMContentLoaded", () => { void refreshObservationAccess(); }, { once: true });
})();
