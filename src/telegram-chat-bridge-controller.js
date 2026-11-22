const REQUIRED_CHAT_BRIDGE_VERSION = 9;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function chatBridgeVersion(contextSnapshot) {
    return Number(contextSnapshot?.extension?.capabilityVersions?.chatBridge) || 0;
}
export function chatGptConversationIdFromUrl(value) {
    try {
        const url = new URL(String(value || ""));
        if (url.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(url.hostname)
            || url.username || url.password || url.port || url.search || url.hash)
            return null;
        const match = url.pathname.match(/^\/(?:g\/[A-Za-z0-9_-]{8,160}\/)?c\/([A-Za-z0-9-]{8,160})\/?$/u);
        const conversationId = match?.[1] || null;
        return conversationId && /^[A-Za-z0-9-]{8,160}$/u.test(conversationId) ? conversationId : null;
    }
    catch {
        return null;
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function taskChatNotStarted(message) {
    const error = new Error(message);
    error.code = "CHAT_BRIDGE_CREATE_NOT_STARTED";
    return error;
}
function validateBinding(binding) {
    if (!binding || typeof binding !== "object")
        throw new Error("Telegram Chat Bridge is not bound to a ChatGPT conversation.");
    const candidate = binding;
    if (!['agent', 'user'].includes(candidate.browserContext))
        throw new Error("Telegram Chat Bridge browser context is invalid.");
    if (typeof candidate.browserInstanceId !== "string" || candidate.browserInstanceId.length < 8 || candidate.browserInstanceId.length > 200)
        throw new Error("Telegram Chat Bridge browser instance is invalid.");
    if (!Number.isInteger(candidate.tabId) || candidate.tabId < 1)
        throw new Error("Telegram Chat Bridge tab is invalid.");
    if (typeof candidate.conversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(candidate.conversationId))
        throw new Error("Telegram Chat Bridge conversation is invalid.");
    if (typeof candidate.canonicalUrl !== "string" || candidate.canonicalUrl.length < 1 || candidate.canonicalUrl.length > 2_000)
        throw new Error("Telegram Chat Bridge canonical URL is invalid.");
    if (chatGptConversationIdFromUrl(candidate.canonicalUrl) !== candidate.conversationId)
        throw new Error("Telegram Chat Bridge canonical URL does not identify the bound conversation.");
    return candidate;
}
export function createTelegramChatBridgeController({ browserBridge, agentControl } = {}) {
    if (!browserBridge?.call || !browserBridge?.snapshot || !agentControl?.assertMutationAllowed) {
        throw new Error("Telegram Chat Bridge controller dependencies are missing.");
    }
    const callContext = async (context, method, args, timeoutMs = 8_000) => (browserBridge.call(method, args, { context, timeoutMs }));
    const inspectBinding = async (rawBinding, requiredVersion = REQUIRED_CHAT_BRIDGE_VERSION, { allowMissingAssistantTurnKey = false, allowMissingUserEpoch = false } = {}) => {
        const binding = validateBinding(rawBinding);
        const snapshot = browserBridge.snapshot();
        const contextState = snapshot?.contexts?.[binding.browserContext];
        if (!contextState?.ready)
            throw new Error("The bound ChatGPT browser context is not connected.");
        const instanceId = contextState.extension?.instanceId || contextState.host?.instanceId || null;
        if (!instanceId || instanceId !== binding.browserInstanceId) {
            throw new Error("The bound ChatGPT browser instance changed. Bind the conversation again from Telegram.");
        }
        const version = chatBridgeVersion(contextState);
        if (version < Math.max(REQUIRED_CHAT_BRIDGE_VERSION, requiredVersion)) {
            throw new Error("The bound browser needs a newer Equinox Browser Chat Bridge capability.");
        }
        const inspectMethod = version >= 3 ? "chat_bridge.inspect" : "continuation.inspect";
        const inspectTab = (tabId) => callContext(binding.browserContext, inspectMethod, { tabId }, 5_000);
        let target = binding;
        let state = null;
        let originalError = null;
        try {
            state = await inspectTab(binding.tabId);
        }
        catch (error) {
            originalError = error;
        }
        if (!state || state?.conversationId !== binding.conversationId) {
            const tabs = await callContext(binding.browserContext, "tabs.list", {}, 5_000).catch(() => null);
            const matches = Array.isArray(tabs)
                ? tabs.filter((tab) => chatGptConversationIdFromUrl(tab?.url) === binding.conversationId)
                : [];
            if (matches.length !== 1) {
                if (originalError && matches.length === 0)
                    throw originalError;
                throw new Error(matches.length > 1
                    ? "The bound ChatGPT conversation is open in multiple tabs. Close duplicates and bind again."
                    : "The bound ChatGPT conversation is no longer open in this browser instance.");
            }
            const reacquiredTabId = Number(matches[0]?.id ?? matches[0]?.tabId);
            if (!Number.isInteger(reacquiredTabId) || reacquiredTabId < 1)
                throw new Error("The reacquired ChatGPT tab identity is invalid.");
            target = Object.freeze({ ...binding, tabId: reacquiredTabId });
            state = await inspectTab(reacquiredTabId);
        }
        if (state?.conversationId !== binding.conversationId)
            throw new Error("The bound ChatGPT tab no longer contains the expected conversation.");
        if ((!allowMissingUserEpoch && !state?.userEpoch) || (!allowMissingAssistantTurnKey && !state?.assistantTurnKey)) {
            throw new Error("The bound ChatGPT conversation does not expose a complete turn identity yet.");
        }
        return { binding: target, state, reacquired: target.tabId !== binding.tabId };
    };
    const deliverText = async ({ binding, deliveryId, text, tool, file, requireExactTab = false } = {}) => {
        const message = typeof text === "string" ? text.trim() : "";
        if ((!message && !file) || message.length > 4_000 || /\0/u.test(message))
            throw new Error("Chat Bridge delivery requires text or an explicitly selected file.");
        if (typeof deliveryId !== "string" || !/^tgb-[a-z0-9-]{6,80}$/u.test(deliveryId))
            throw new Error("Telegram Chat Bridge delivery id is invalid.");
        agentControl.assertMutationAllowed("telegram_chat_bridge_delivery");
        const { binding: target, state } = await inspectBinding(binding);
        if (requireExactTab && target.tabId !== binding?.tabId) {
            // Native Chat is explicitly tab-bound. Telegram can continue using
            // documented re-acquisition, but native sends must never silently jump
            // to another Chrome tab after the original one disappears.
            const error = new Error("The selected Chrome tab changed. Select that conversation again before sending.");
            error.code = "CHAT_BRIDGE_NOT_READY";
            throw error;
        }
        if (state.generationActive) {
            const error = new Error("ChatGPT is still generating in the bound conversation. Try again when it is idle.");
            error.code = "CHAT_BRIDGE_NOT_READY";
            throw error;
        }
        if (!state.composerReady || !state.composerEmpty) {
            const error = new Error("The bound ChatGPT composer is unavailable or already contains human input.");
            error.code = "CHAT_BRIDGE_NOT_READY";
            throw error;
        }
        try {
            const result = await callContext(target.browserContext, "chat_bridge.deliver", {
                deliveryId,
                tabId: target.tabId,
                conversationId: target.conversationId,
                userEpoch: state.userEpoch,
                assistantTurnKey: state.assistantTurnKey,
                text: message,
                ...(tool ? { toolName: tool.name, toolKind: tool.kind } : {}),
                ...(file ? { filePath: file.path, fileName: file.name, fileSize: file.size } : {}),
            }, file ? 75_000 : tool ? 16_000 : 10_000);
            if (result?.confirmed === true) {
                if (typeof result.userEpoch !== "string" || typeof result.previousAssistantTurnKey !== "string") {
                    const error = new Error("Telegram Chat Bridge delivery confirmation is missing turn identity.");
                    error.code = "CHAT_BRIDGE_AMBIGUOUS";
                    throw error;
                }
                return Object.freeze({
                    confirmed: true,
                    duplicatePrevented: false,
                    deliveryId,
                    userEpoch: result.userEpoch,
                    previousAssistantTurnKey: result.previousAssistantTurnKey,
                    tabId: target.tabId,
                });
            }
            if (result?.duplicatePrevented === true)
                return Object.freeze({ confirmed: false, duplicatePrevented: true, deliveryId });
            const stage = typeof result?.stage === "string" ? result.stage.slice(0, 80) : "unknown";
            const error = new Error(`Telegram Chat Bridge delivery became ambiguous at stage ${stage} and will not be retried automatically.`);
            error.code = "CHAT_BRIDGE_AMBIGUOUS";
            throw error;
        }
        catch (error) {
            if (error?.code === "CHAT_BRIDGE_NOT_READY" || error?.code === "CHAT_BRIDGE_AMBIGUOUS")
                throw error;
            const ambiguous = new Error(`Telegram Chat Bridge delivery may have crossed the browser boundary: ${errorMessage(error).slice(0, 220)}`);
            ambiguous.code = "CHAT_BRIDGE_AMBIGUOUS";
            throw ambiguous;
        }
    };
    const startTaskChat = async ({ taskId, checkpointRevision = 1, initialMessage, modelChoice, effortLevel } = {}) => {
        if (typeof taskId !== "string" || !/^task-[a-z0-9-]{6,80}$/u.test(taskId))
            throw new Error("Telegram new-task id is invalid.");
        if (!Number.isInteger(checkpointRevision) || checkpointRevision < 1)
            throw new Error("Telegram new-task checkpoint revision is invalid.");
        if (initialMessage !== undefined && (typeof initialMessage !== "string" || !initialMessage.trim() || initialMessage.length > 1500 || /[\r\n]/u.test(initialMessage))) {
            throw new Error("Task chat initial message must be a nonempty single line of at most 1500 characters.");
        }
        if (modelChoice !== undefined && (typeof modelChoice !== "string" || !modelChoice.trim() || modelChoice.length > 80))
            throw new Error("New Chat requested an invalid model name.");
        if (effortLevel !== undefined && (!Number.isInteger(effortLevel) || effortLevel < 0 || effortLevel > 12))
            throw new Error("New Chat requested an invalid effort level.");
        const prompt = initialMessage ?? `Start task ${taskId} from checkpoint ${checkpointRevision}. Read the latest Task Capsule from Equinox Local and carry out its objective.`;
        agentControl.assertMutationAllowed("telegram_task_chat_create");
        const bridgeSnapshot = browserBridge.snapshot();
        const contextState = bridgeSnapshot?.contexts?.user;
        if (!contextState?.ready)
            throw new Error("Your Browser is not connected.");
        const instanceId = contextState.extension?.instanceId || contextState.host?.instanceId || null;
        if (!instanceId)
            throw new Error("Your Browser instance identity is unavailable.");
        if (chatBridgeVersion(contextState) < REQUIRED_CHAT_BRIDGE_VERSION) {
            throw new Error("Your Browser needs a newer Equinox Browser Chat Bridge capability.");
        }
        let createdTabId = null;
        let mutationStarted = false;
        let submitBoundaryCrossed = false;
        let submitAttemptUncertain = false;
        try {
            // Chrome can create a tab even when the bridge response is lost. Reserve the
            // mutation boundary BEFORE the request so this cannot be misreported as
            // a safe pre-creation failure or automatically retried by callers.
            mutationStarted = true;
            const created = await callContext("user", "tabs.create", { url: "https://chatgpt.com/", active: true }, 8_000);
            createdTabId = Number(created?.id ?? created?.tabId);
            if (!Number.isInteger(createdTabId) || createdTabId < 1)
                throw new Error("ChatGPT task-chat creation did not return a tab id.");
            // Apply an explicit model/effort setting on the NEW provider composer
            // before prompt entry or the irreversible send boundary.
            if (modelChoice !== undefined || effortLevel !== undefined) {
                try {
                    if (chatBridgeVersion(contextState) < 13)
                        throw new Error("Equinox Browser does not support new-chat model selection.");
                    const discover = await callContext("user", "chat_bridge.model", { tabId: createdTabId, conversationId: null, action: "discover" }, 11_000);
                    if (discover?.available !== true || discover?.discovered !== true
                        || !Array.isArray(discover.choices))
                        throw new Error("ChatGPT model options are unavailable.");
                    if (modelChoice !== undefined) {
                        if (discover.choices.filter((item) => item?.label === modelChoice).length !== 1)
                            throw new Error("The requested model is not offered to this account.");
                        const changed = await callContext("user", "chat_bridge.model", { tabId: createdTabId, conversationId: null, action: "choose", choice: modelChoice }, 11_000);
                        if (changed?.confirmed !== true || changed?.selectedModel !== modelChoice)
                            throw new Error("ChatGPT did not confirm the selected model.");
                    }
                    if (effortLevel !== undefined) {
                        const inspected = await callContext("user", "chat_bridge.model", { tabId: createdTabId, conversationId: null, action: "discover" }, 11_000);
                        let power = inspected?.power;
                        if (!power || !Number.isInteger(power.value) || !Number.isInteger(power.min)
                            || !Number.isInteger(power.max) || effortLevel < power.min || effortLevel > power.max)
                            throw new Error("The requested effort level is not offered.");
                        for (let step = 0; power.value !== effortLevel && step < 12; step++) {
                            const direction = power.value < effortLevel ? "right" : "left";
                            const updated = await callContext("user", "chat_bridge.model", { tabId: createdTabId, conversationId: null, action: "power", direction }, 11_000);
                            if (updated?.confirmed !== true || !Number.isInteger(updated?.power?.value)
                                || Math.abs(updated.power.value - power.value) !== 1)
                                throw new Error("ChatGPT did not confirm the effort change.");
                            power = updated.power;
                        }
                        if (power.value !== effortLevel)
                            throw new Error("The requested effort could not be reached in ChatGPT.");
                    }
                }
                catch (error) {
                    // The user prompt has not entered the composer or been sent, so
                    // the existing definitive cleanup closes the empty new-chat tab.
                    throw taskChatNotStarted("New Chat model selection failed before submit: " + errorMessage(error).slice(0, 170));
                }
            }
            let promptSubmitted = false;
            let lastComposerError = null;
            let lastSendReason = "not_ready";
            const readyDeadline = Date.now() + 12_000;
            const inspectComposer = async () => {
                const result = await callContext("user", "eval", {
                    tabId: createdTabId,
                    expression: `(() => {
            const candidates = [...document.querySelectorAll('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]')];
            const visible = candidates.filter(node => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return node.isConnected && node.getClientRects().length > 0
                && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            });
            const composer = visible.length === 1 ? visible[0] : null;
            return {
              present: Boolean(composer),
              text: composer ? String(composer.textContent || '').trim() : '',
              generationActive: [...document.querySelectorAll('button[data-testid="stop-button"]')]
                .some(button => button.isConnected && button.getClientRects().length > 0
                  && button.getBoundingClientRect().height > 0 && button.getBoundingClientRect().width > 0
                  && getComputedStyle(button).visibility !== 'hidden'),
            };
          })()`,
                }, 5_000).catch(() => null);
                return result?.value && typeof result.value === "object" ? result.value : { present: false, text: "", generationActive: false };
            };
            while (Date.now() < readyDeadline && !promptSubmitted) {
                const before = await inspectComposer();
                if (before.generationActive)
                    throw taskChatNotStarted("ChatGPT task-chat found an unexpected active generation before submit.");
                if (before.text && before.text !== prompt) {
                    throw taskChatNotStarted("ChatGPT task-chat composer contains unexpected text before submit.");
                }
                if (before.text !== prompt) {
                    let composerRef = null;
                    try {
                        const snapshotResult = await callContext("user", "snapshot", {
                            tabId: createdTabId,
                            includeReadable: false,
                            mode: "interactive",
                            scope: "viewport",
                            maxNodes: 40,
                            roles: ["textbox"],
                            output: "both",
                        }, 8_000);
                        const textboxes = Array.isArray(snapshotResult?.elements)
                            ? snapshotResult.elements.filter((item) => item?.role === "textbox" && typeof item?.ref === "string")
                            : [];
                        if (snapshotResult?.refContextValid !== false && textboxes.length === 1)
                            composerRef = textboxes[0].ref;
                    }
                    catch (error) {
                        lastComposerError = error;
                    }
                    if (!composerRef) {
                        await sleep(150);
                        continue;
                    }
                    let inputError = null;
                    try {
                        // A long first message sent as sequential key events can outlive
                        // the IPC deadline and leave a partial draft behind. Browser fill
                        // applies one bounded contenteditable replacement without submit;
                        // inspectComposer below still verifies the exact final text.
                        await callContext("user", "fill", {
                            tabId: createdTabId,
                            ref: composerRef,
                            value: prompt,
                        }, 12_000);
                    }
                    catch (error) {
                        inputError = error;
                        lastComposerError = error;
                    }
                    const afterInput = await inspectComposer();
                    if (afterInput.generationActive)
                        throw taskChatNotStarted("ChatGPT task-chat found an unexpected active generation after composer input.");
                    if (afterInput.text === prompt) {
                        // The prompt is present in the current live composer. A stale/actionability error from
                        // the old ref is harmless here because no submit boundary has been crossed yet.
                    }
                    else if (!afterInput.present || !afterInput.text) {
                        // ChatGPT can replace the root composer during startup hydration. Nothing is currently
                        // staged, so taking a fresh snapshot and retrying is safe and cannot duplicate a send.
                        await sleep(150);
                        continue;
                    }
                    else {
                        throw taskChatNotStarted("ChatGPT task-chat composer postcondition changed before submit" + (inputError ? ": " + errorMessage(inputError).slice(0, 160) : "."));
                    }
                }
                const sendDeadline = Math.min(readyDeadline, Date.now() + 4_000);
                let clicked = false;
                let composerReset = false;
                while (Date.now() < sendDeadline && !clicked) {
                    const readiness = await callContext("user", "eval", {
                        tabId: createdTabId,
                        expression: `(() => {
              // The current ChatGPT UI uses an unnamed primary composer action (type=submit) for Send.
              // Keep older explicit ids as safe fallbacks; never target voice/stop (type=button).
              const selector = '[data-composer-body] button.bg-composer-primary[type="submit"], button[data-testid="send-button"][type="submit"], button#composer-submit-button[type="submit"]:not([data-testid="stop-button"])';
              const isVisible = node => {
                const rect = node.getBoundingClientRect();
                const style = getComputedStyle(node);
                return node.isConnected && node.getClientRects().length > 0
                  && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const editors = [...document.querySelectorAll('#prompt-textarea[contenteditable="true"][role="textbox"], [data-composer-markdown][contenteditable="true"][role="textbox"]')].filter(isVisible);
              const composer = editors.length === 1 ? editors[0] : null;
              const buttons = [...document.querySelectorAll(selector)].filter(isVisible);
              const button = buttons.length === 1 ? buttons[0] : null;
              const text = composer ? String(composer.textContent || '').trim() : '';
              if (!composer) return { ready: false, reason: editors.length > 1 ? "composer_ambiguous" : "composer_missing", name: null, text };
              if (!text) return { ready: false, reason: "composer_empty", name: null, text };
              if (text !== ${JSON.stringify(prompt)}) return { ready: false, reason: "composer_changed", name: null, text };
              if (!button) return { ready: false, reason: buttons.length > 1 ? "send_button_ambiguous" : "send_button_missing", name: null, text };
              if (button.getAttribute('data-testid') === 'stop-button') return { ready: false, reason: "generation_active", name: null, text };
              if (Boolean(button.disabled) || button.getAttribute('aria-disabled') === 'true') return { ready: false, reason: "send_disabled", name: null, text };
              const name = String(button.getAttribute('aria-label') || button.textContent || '').replace(/\s+/gu, ' ').trim();
              return { ready: true, reason: null, name, text };
            })()`,
                    }, 5_000);
                    const candidate = readiness?.value;
                    if (candidate?.ready !== true) {
                        lastSendReason = candidate?.reason || "not_ready";
                        if (["composer_missing", "composer_empty"].includes(lastSendReason)) {
                            composerReset = true;
                            break;
                        }
                        if (["composer_changed", "generation_active"].includes(lastSendReason)) {
                            throw taskChatNotStarted(`ChatGPT task-chat send target changed before click: ${lastSendReason}.`);
                        }
                        await sleep(100);
                        continue;
                    }
                    const sendSnapshot = await callContext("user", "snapshot", {
                        tabId: createdTabId,
                        includeReadable: false,
                        mode: "interactive",
                        scope: "viewport",
                        maxNodes: 120,
                        roles: ["button"],
                        output: "both",
                    }, 8_000);
                    const buttons = Array.isArray(sendSnapshot?.elements)
                        ? sendSnapshot.elements.filter((item) => item?.role === "button" && typeof item?.ref === "string")
                        : [];
                    const matches = candidate.name
                        ? buttons.filter((item) => String(item?.name || "").trim() === candidate.name)
                        : [];
                    if (matches.length !== 1) {
                        lastSendReason = matches.length > 1 ? "send_button_ambiguous" : "send_button_ref_missing";
                        await sleep(100);
                        continue;
                    }
                    submitAttemptUncertain = true;
                    const clickResult = await callContext("user", "click", { tabId: createdTabId, ref: matches[0].ref }, 8_000);
                    submitAttemptUncertain = false;
                    if (clickResult?.actionDispatched === true || clickResult?.primaryActionSucceeded === true) {
                        submitBoundaryCrossed = true;
                        clicked = true;
                        break;
                    }
                    if (clickResult?.outcomeUncertain === true) {
                        submitAttemptUncertain = true;
                        throw new Error("ChatGPT task-chat send-button click outcome is uncertain.");
                    }
                    lastSendReason = clickResult?.actionabilityReason || "send_button_not_dispatched";
                    await sleep(100);
                }
                if (clicked) {
                    promptSubmitted = true;
                    break;
                }
                if (composerReset) {
                    await sleep(150);
                    continue;
                }
                // The prompt is still staged but the trusted send control was not ready. Keep waiting
                // inside the overall bounded readiness window without typing the prompt a second time.
                await sleep(150);
            }
            if (!promptSubmitted) {
                throw taskChatNotStarted("ChatGPT task-chat composer/send control did not remain stable long enough to submit the Task prompt" + (lastComposerError ? ": " + errorMessage(lastComposerError).slice(0, 120) : lastSendReason ? ` (${lastSendReason}).` : "."));
            }
            // A fresh ChatGPT conversation may finish the first assistant turn before
            // Chrome publishes its final /c/ URL. Observe only the tab we created,
            // and accept its identity only when the tab route or the first-party Chat
            // Bridge observer supplies an exact, validated conversation identity.
            let identity = null;
            let turnState = null;
            const conversationDeadline = Date.now() + 35_000;
            while (Date.now() < conversationDeadline && !identity) {
                const tabs = await callContext("user", "tabs.list", {}, 4_000).catch(() => null);
                const tab = Array.isArray(tabs) ? tabs.find((item) => Number(item?.id ?? item?.tabId) === createdTabId) : null;
                const urlId = chatGptConversationIdFromUrl(tab?.url);
                const observed = await callContext("user", "chat_bridge.inspect", { tabId: createdTabId }, 5_000).catch(() => null);
                const observerUrl = typeof observed?.canonicalUrl === "string" ? observed.canonicalUrl : null;
                const observerId = chatGptConversationIdFromUrl(observerUrl);
                if (urlId && observerId && urlId !== observerId) {
                    throw new Error("ChatGPT task-chat tab and Browser Chat Bridge disagree about the conversation identity.");
                }
                const conversationId = urlId || (observerId && observed?.conversationId === observerId ? observerId : null);
                const canonicalUrl = urlId ? String(tab.url) : observerUrl;
                if (conversationId && canonicalUrl && tab) {
                    identity = {
                        conversationId,
                        canonicalUrl,
                        title: String(tab.title || "ChatGPT").slice(0, 200),
                    };
                    turnState = observed?.conversationId === conversationId ? observed : null;
                    break;
                }
                await sleep(250);
            }
            if (!identity)
                throw new Error("ChatGPT task conversation identity could not be confirmed before the bounded deadline.");
            return Object.freeze({
                confirmed: true,
                binding: Object.freeze({
                    sourceTaskId: taskId,
                    browserContext: "user",
                    browserInstanceId: instanceId,
                    tabId: createdTabId,
                    conversationId: identity.conversationId,
                    canonicalUrl: identity.canonicalUrl,
                    title: identity.title,
                    boundAt: new Date().toISOString(),
                }),
                userEpoch: turnState?.userEpoch || null,
                previousAssistantTurnKey: null,
            });
        }
        catch (error) {
            if (error?.code === "CHAT_BRIDGE_CREATE_NOT_STARTED" && !submitBoundaryCrossed && !submitAttemptUncertain) {
                if (createdTabId)
                    await callContext("user", "close", { tabId: createdTabId }, 5_000).catch(() => { });
                throw error;
            }
            if (mutationStarted) {
                const ambiguous = new Error("Telegram new-task chat creation became ambiguous: " + errorMessage(error).slice(0, 220));
                ambiguous.code = "CHAT_BRIDGE_AMBIGUOUS";
                if (createdTabId)
                    ambiguous.candidateTabId = createdTabId;
                throw ambiguous;
            }
            throw error;
        }
    };
    const inspectTurnIdentity = async ({ binding } = {}) => {
        try {
            const { binding: target, state } = await inspectBinding(binding, REQUIRED_CHAT_BRIDGE_VERSION, {
                allowMissingAssistantTurnKey: true,
                allowMissingUserEpoch: true,
            });
            return Object.freeze({
                status: state?.userEpoch ? "ready" : "waiting",
                binding: target,
                userEpoch: state?.userEpoch || null,
                assistantTurnKey: state?.assistantTurnKey || null,
                generationActive: state?.generationActive === true,
                composerReady: state?.composerReady === true,
                composerEmpty: state?.composerEmpty === true,
            });
        }
        catch (error) {
            const message = errorMessage(error);
            if (/browser instance changed|no longer contains the expected conversation|open in multiple tabs|newer Equinox Browser Chat Bridge capability/iu.test(message)) {
                const drifted = new Error(message);
                drifted.code = "CHAT_BRIDGE_DRIFTED";
                throw drifted;
            }
            const retryable = new Error(message);
            retryable.code = "CHAT_BRIDGE_READ_RETRYABLE";
            throw retryable;
        }
    };
    const validateChatRichText = (value, limit) => {
        if (value === null || value === undefined)
            return null;
        if (typeof value !== "string" || [...value].length > limit)
            return null;
        return value;
    };
    const readFinal = async ({ binding, userEpoch, previousAssistantTurnKey } = {}) => {
        let target;
        try {
            ({ binding: target } = await inspectBinding(binding, REQUIRED_CHAT_BRIDGE_VERSION, { allowMissingAssistantTurnKey: previousAssistantTurnKey === null }));
        }
        catch (error) {
            const message = errorMessage(error);
            if (/browser instance changed|no longer contains the expected conversation|newer Equinox Browser Chat Bridge capability/iu.test(message)) {
                const drifted = new Error(message);
                drifted.code = "CHAT_BRIDGE_DRIFTED";
                throw drifted;
            }
            const notReady = new Error(message);
            notReady.code = "CHAT_BRIDGE_READ_RETRYABLE";
            throw notReady;
        }
        if (typeof userEpoch !== "string" || userEpoch.length < 1 || userEpoch.length > 200)
            throw new Error("Telegram Chat Bridge pending user epoch is invalid.");
        if (previousAssistantTurnKey !== null && (typeof previousAssistantTurnKey !== "string" || previousAssistantTurnKey.length < 1 || previousAssistantTurnKey.length > 200))
            throw new Error("Telegram Chat Bridge pending assistant turn is invalid.");
        const result = await callContext(target.browserContext, "chat_bridge.read_final", {
            tabId: target.tabId,
            conversationId: target.conversationId,
            userEpoch,
            previousAssistantTurnKey,
        }, 8_000);
        if (result?.status === "waiting")
            return Object.freeze({ status: "waiting", tabId: target.tabId });
        if (result?.status === "drifted") {
            const error = new Error(`Telegram Chat Bridge response target drifted: ${String(result.reason || "unknown").slice(0, 120)}`);
            error.code = "CHAT_BRIDGE_DRIFTED";
            throw error;
        }
        if (result?.status !== "ready" || typeof result.text !== "string" || !result.text.trim() || typeof result.assistantTurnKey !== "string") {
            const error = new Error("Telegram Chat Bridge returned an invalid final-response payload.");
            error.code = "CHAT_BRIDGE_READ_FAILED";
            throw error;
        }
        return Object.freeze({
            status: "ready",
            text: result.text,
            assistantTurnKey: result.assistantTurnKey,
            truncated: result.truncated === true,
            richText: validateChatRichText(result.richText, 14_000),
            tabId: target.tabId,
        });
    };
    const readRecent = async ({ binding } = {}) => {
        const { binding: target } = await inspectBinding(binding, 10, { allowMissingUserEpoch: true, allowMissingAssistantTurnKey: true });
        const value = await callContext(target.browserContext, "chat_bridge.recent", {
            tabId: target.tabId, conversationId: target.conversationId,
        }, 10_000);
        if (!Array.isArray(value?.items) || value.items.length > 24)
            throw new Error("Chat Bridge recent transcript is invalid.");
        let remainingRich = 46_000;
        const items = value.items.map((item) => {
            if (!item || !["user", "assistant"].includes(item.role) || typeof item.text !== "string" || item.text.length > 14000 || typeof item.id !== "string" || item.id.length > 220)
                throw new Error("Chat Bridge transcript message is invalid.");
            const candidate = item.role === "assistant" ? validateChatRichText(item.richText, 5000) : null;
            const size = candidate ? [...candidate].length : 0;
            const richText = candidate && size <= remainingRich ? candidate : null;
            remainingRich -= richText ? size : 0;
            return { id: item.id, role: item.role, text: item.text, truncated: item.truncated === true, richText };
        });
        return Object.freeze({ items, partial: value.partial === true, tabId: target.tabId });
    };
    const readLive = async ({ binding, userEpoch } = {}) => {
        if (typeof userEpoch !== "string" || userEpoch.length < 1 || userEpoch.length > 200)
            throw new Error("Chat Bridge live preview user epoch is invalid.");
        const { binding: target, state } = await inspectBinding(binding, 11, { allowMissingUserEpoch: true, allowMissingAssistantTurnKey: true });
        if (state?.userEpoch !== userEpoch)
            return Object.freeze({ status: "drifted", text: "" });
        if (!state?.generationActive)
            return Object.freeze({ status: "idle", text: "" });
        const result = await callContext(target.browserContext, "chat_bridge.live", {
            tabId: target.tabId, conversationId: target.conversationId, userEpoch,
        }, 10_000);
        if (!result || !["drifted", "idle", "generating"].includes(result.status) ||
            (result.text !== undefined && (typeof result.text !== "string" || [...result.text].length > 3200)))
            throw new Error("Chat Bridge live preview payload is invalid.");
        return Object.freeze({ status: result.status, text: typeof result.text === "string" ? result.text : "", truncated: result.truncated === true,
            richText: validateChatRichText(result.richText, 4000), tabId: target.tabId });
    };
    return Object.freeze({ inspectBinding, inspectTurnIdentity, deliverText, readFinal, readRecent, readLive, startTaskChat });
}
