const REQUIRED_CHAT_BRIDGE_VERSION = 9;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function chatBridgeVersion(contextSnapshot) {
  return Number(contextSnapshot?.extension?.capabilityVersions?.chatBridge) || 0;
}

function chatGptConversationIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!['chatgpt.com', 'www.chatgpt.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/\/c\/([^/]+)\/?$/u);
    const conversationId = match?.[1] || null;
    return conversationId && /^[A-Za-z0-9-]{8,160}$/u.test(conversationId) ? conversationId : null;
  } catch {
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
  if (!binding || typeof binding !== "object") throw new Error("Telegram Chat Bridge is not bound to a ChatGPT conversation.");
  if (!['agent', 'user'].includes(binding.browserContext)) throw new Error("Telegram Chat Bridge browser context is invalid.");
  if (typeof binding.browserInstanceId !== "string" || binding.browserInstanceId.length < 8 || binding.browserInstanceId.length > 200) throw new Error("Telegram Chat Bridge browser instance is invalid.");
  if (!Number.isInteger(binding.tabId) || binding.tabId < 1) throw new Error("Telegram Chat Bridge tab is invalid.");
  if (typeof binding.conversationId !== "string" || !/^[A-Za-z0-9-]{8,160}$/u.test(binding.conversationId)) throw new Error("Telegram Chat Bridge conversation is invalid.");
  if (typeof binding.canonicalUrl !== "string" || binding.canonicalUrl.length < 1 || binding.canonicalUrl.length > 2_000) throw new Error("Telegram Chat Bridge canonical URL is invalid.");
  return binding;
}

export function createTelegramChatBridgeController({ browserBridge, agentControl } = {}) {
  if (!browserBridge?.call || !browserBridge?.snapshot || !agentControl?.assertMutationAllowed) {
    throw new Error("Telegram Chat Bridge controller dependencies are missing.");
  }

  const callContext = async (context, method, args, timeoutMs = 8_000) => (
    browserBridge.call(method, args, { context, timeoutMs })
  );

  const inspectBinding = async (rawBinding, requiredVersion = REQUIRED_CHAT_BRIDGE_VERSION, { allowMissingAssistantTurnKey = false, allowMissingUserEpoch = false } = {}) => {
    const binding = validateBinding(rawBinding);
    const snapshot = browserBridge.snapshot();
    const contextState = snapshot?.contexts?.[binding.browserContext];
    if (!contextState?.ready) throw new Error("The bound ChatGPT browser context is not connected.");
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
    } catch (error) {
      originalError = error;
    }

    if (!state || state?.conversationId !== binding.conversationId) {
      const tabs = await callContext(binding.browserContext, "tabs.list", {}, 5_000).catch(() => null);
      const matches = Array.isArray(tabs)
        ? tabs.filter((tab) => chatGptConversationIdFromUrl(tab?.url) === binding.conversationId)
        : [];
      if (matches.length !== 1) {
        if (originalError && matches.length === 0) throw originalError;
        throw new Error(matches.length > 1
          ? "The bound ChatGPT conversation is open in multiple tabs. Close duplicates and bind again."
          : "The bound ChatGPT conversation is no longer open in this browser instance.");
      }
      const reacquiredTabId = Number(matches[0]?.id ?? matches[0]?.tabId);
      if (!Number.isInteger(reacquiredTabId) || reacquiredTabId < 1) throw new Error("The reacquired ChatGPT tab identity is invalid.");
      target = Object.freeze({ ...binding, tabId: reacquiredTabId });
      state = await inspectTab(reacquiredTabId);
    }

    if (state?.conversationId !== binding.conversationId) throw new Error("The bound ChatGPT tab no longer contains the expected conversation.");
    if ((!allowMissingUserEpoch && !state?.userEpoch) || (!allowMissingAssistantTurnKey && !state?.assistantTurnKey)) {
      throw new Error("The bound ChatGPT conversation does not expose a complete turn identity yet.");
    }
    return { binding: target, state, reacquired: target.tabId !== binding.tabId };
  };

  const deliverText = async ({ binding, deliveryId, text } = {}) => {
    const message = typeof text === "string" ? text.trim() : "";
    if (!message || message.length > 4_000 || /\0/u.test(message)) throw new Error("Telegram Chat Bridge message must contain 1–4000 safe characters.");
    if (typeof deliveryId !== "string" || !/^tgb-[a-z0-9-]{6,80}$/u.test(deliveryId)) throw new Error("Telegram Chat Bridge delivery id is invalid.");
    agentControl.assertMutationAllowed("telegram_chat_bridge_delivery");
    const { binding: target, state } = await inspectBinding(binding);
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
      }, 10_000);
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
      if (result?.duplicatePrevented === true) return Object.freeze({ confirmed: false, duplicatePrevented: true, deliveryId });
      const stage = typeof result?.stage === "string" ? result.stage.slice(0, 80) : "unknown";
      const error = new Error(`Telegram Chat Bridge delivery became ambiguous at stage ${stage} and will not be retried automatically.`);
      error.code = "CHAT_BRIDGE_AMBIGUOUS";
      throw error;
    } catch (error) {
      if (error?.code === "CHAT_BRIDGE_NOT_READY" || error?.code === "CHAT_BRIDGE_AMBIGUOUS") throw error;
      const ambiguous = new Error(`Telegram Chat Bridge delivery may have crossed the browser boundary: ${errorMessage(error).slice(0, 220)}`);
      ambiguous.code = "CHAT_BRIDGE_AMBIGUOUS";
      throw ambiguous;
    }
  };


  const startTaskChat = async ({ taskId, checkpointRevision = 1 } = {}) => {
    if (typeof taskId !== "string" || !/^task-[a-z0-9-]{6,80}$/u.test(taskId)) throw new Error("Telegram new-task id is invalid.");
    if (!Number.isInteger(checkpointRevision) || checkpointRevision < 1) throw new Error("Telegram new-task checkpoint revision is invalid.");
    const prompt = `Start task ${taskId} from checkpoint ${checkpointRevision}. Read the latest Task Capsule from Equinox Local and carry out its objective.`;

    agentControl.assertMutationAllowed("telegram_task_chat_create");
    const bridgeSnapshot = browserBridge.snapshot();
    const contextState = bridgeSnapshot?.contexts?.user;
    if (!contextState?.ready) throw new Error("Your Browser is not connected.");
    const instanceId = contextState.extension?.instanceId || contextState.host?.instanceId || null;
    if (!instanceId) throw new Error("Your Browser instance identity is unavailable.");
    if (chatBridgeVersion(contextState) < REQUIRED_CHAT_BRIDGE_VERSION) {
      throw new Error("Your Browser needs a newer Equinox Browser Chat Bridge capability.");
    }

    let createdTabId = null;
    let mutationStarted = false;
    let submitBoundaryCrossed = false;
    let submitAttemptUncertain = false;
    try {
      const created = await callContext("user", "tabs.create", { url: "https://chatgpt.com/", active: true }, 8_000);
      createdTabId = Number(created?.id ?? created?.tabId);
      if (!Number.isInteger(createdTabId) || createdTabId < 1) throw new Error("ChatGPT task-chat creation did not return a tab id.");
      mutationStarted = true;

      let promptSubmitted = false;
      let lastComposerError = null;
      let lastSendReason = "not_ready";
      const readyDeadline = Date.now() + 12_000;
      const inspectComposer = async () => {
        const result = await callContext("user", "eval", {
          tabId: createdTabId,
          expression: `(() => {
            const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"]');
            return {
              present: Boolean(composer),
              text: composer ? String(composer.textContent || '').trim() : '',
              generationActive: Boolean(document.querySelector('button[data-testid="stop-button"]')),
            };
          })()`,
        }, 5_000).catch(() => null);
        return result?.value && typeof result.value === "object" ? result.value : { present: false, text: "", generationActive: false };
      };

      while (Date.now() < readyDeadline && !promptSubmitted) {
        const before = await inspectComposer();
        if (before.generationActive) throw taskChatNotStarted("ChatGPT task-chat found an unexpected active generation before submit.");
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
            if (snapshotResult?.refContextValid !== false && textboxes.length === 1) composerRef = textboxes[0].ref;
          } catch (error) {
            lastComposerError = error;
          }
          if (!composerRef) {
            await sleep(150);
            continue;
          }

          let inputError = null;
          try {
            await callContext("user", "type_text", {
              tabId: createdTabId,
              ref: composerRef,
              text: prompt,
              delayMs: 0,
            }, 12_000);
          } catch (error) {
            inputError = error;
            lastComposerError = error;
          }

          const afterInput = await inspectComposer();
          if (afterInput.generationActive) throw taskChatNotStarted("ChatGPT task-chat found an unexpected active generation after composer input.");
          if (afterInput.text === prompt) {
            // The prompt is present in the current live composer. A stale/actionability error from
            // the old ref is harmless here because no submit boundary has been crossed yet.
          } else if (!afterInput.present || !afterInput.text) {
            // ChatGPT can replace the root composer during startup hydration. Nothing is currently
            // staged, so taking a fresh snapshot and retrying is safe and cannot duplicate a send.
            await sleep(150);
            continue;
          } else {
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
              const selector = 'button[data-testid="send-button"][type="submit"], button#composer-submit-button[type="submit"]:not([data-testid="stop-button"])';
              const composer = document.querySelector('#prompt-textarea[contenteditable="true"][role="textbox"]');
              const button = document.querySelector(selector);
              const text = composer ? String(composer.textContent || '').trim() : '';
              if (!composer) return { ready: false, reason: "composer_missing", name: null, text };
              if (!text) return { ready: false, reason: "composer_empty", name: null, text };
              if (text !== ${JSON.stringify(prompt)}) return { ready: false, reason: "composer_changed", name: null, text };
              if (!button || !button.isConnected) return { ready: false, reason: "send_button_missing", name: null, text };
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

      let identity = null;
      const conversationDeadline = Date.now() + 12_000;
      while (Date.now() < conversationDeadline && !identity) {
        const tabs = await callContext("user", "tabs.list", {}, 5_000);
        const tab = Array.isArray(tabs) ? tabs.find((item) => Number(item?.id ?? item?.tabId) === createdTabId) : null;
        const conversationId = chatGptConversationIdFromUrl(tab?.url);
        if (conversationId) {
          identity = {
            conversationId,
            canonicalUrl: String(tab.url),
            title: String(tab.title || "ChatGPT").slice(0, 200),
          };
          break;
        }
        await sleep(150);
      }
      if (!identity) throw new Error("ChatGPT task conversation identity could not be confirmed.");

      const inspected = await callContext("user", "chat_bridge.inspect", { tabId: createdTabId }, 5_000).catch(() => null);
      const turnState = inspected?.conversationId === identity.conversationId ? inspected : null;

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
    } catch (error) {
      if (error?.code === "CHAT_BRIDGE_CREATE_NOT_STARTED" && !submitBoundaryCrossed && !submitAttemptUncertain) {
        if (createdTabId) await callContext("user", "close", { tabId: createdTabId }, 5_000).catch(() => {});
        throw error;
      }
      if (mutationStarted) {
        const ambiguous = new Error("Telegram new-task chat creation became ambiguous: " + errorMessage(error).slice(0, 220));
        ambiguous.code = "CHAT_BRIDGE_AMBIGUOUS";
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
      });
    } catch (error) {
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

  const readFinal = async ({ binding, userEpoch, previousAssistantTurnKey } = {}) => {
    let target;
    try {
      ({ binding: target } = await inspectBinding(binding, REQUIRED_CHAT_BRIDGE_VERSION, { allowMissingAssistantTurnKey: previousAssistantTurnKey === null }));
    } catch (error) {
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
    if (typeof userEpoch !== "string" || userEpoch.length < 1 || userEpoch.length > 200) throw new Error("Telegram Chat Bridge pending user epoch is invalid.");
    if (previousAssistantTurnKey !== null && (typeof previousAssistantTurnKey !== "string" || previousAssistantTurnKey.length < 1 || previousAssistantTurnKey.length > 200)) throw new Error("Telegram Chat Bridge pending assistant turn is invalid.");
    const result = await callContext(target.browserContext, "chat_bridge.read_final", {
      tabId: target.tabId,
      conversationId: target.conversationId,
      userEpoch,
      previousAssistantTurnKey,
    }, 8_000);
    if (result?.status === "waiting") return Object.freeze({ status: "waiting", tabId: target.tabId });
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
      tabId: target.tabId,
    });
  };

  return Object.freeze({ inspectBinding, inspectTurnIdentity, deliverText, readFinal, startTaskChat });
}
