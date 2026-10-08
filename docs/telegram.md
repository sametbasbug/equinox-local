# Telegram & Task Capsules

Telegram is an **optional** private remote-control channel for Equinox Local. It does not replace ChatGPT, and Equinox Local does not offer agents a general-purpose Telegram inbox.

## Pair your own bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and follow its prompts.
2. In **Equinox Local → Setup** (or **Control Center → Services → Telegram**), paste the bot token and choose **Pair Telegram**.
3. Open your new bot in Telegram and send `/start`.
4. Confirm the suggested private Telegram account in Control Center. Your bot is now paired to **one explicitly approved private recipient**.

Never paste the bot token into a GitHub issue, a Telegram group or a public log. Pairing is optional and can be skipped during first-time setup.

## From Telegram to ChatGPT

| Command or action | What it does |
| --- | --- |
| `/status` | View runtime, Browser and current task status; access guarded agent control actions. |
| `/tasks` | View and select active Task Capsules, or choose **➕ New task**. |
| **➕ New task** | Send a description; Local creates one new Task Capsule and ChatGPT conversation, then forwards the first completed answer. |
| Select an active task | Bind normal Telegram text to **that task's verified ChatGPT conversation**. |
| `/chat` | Show the selected bound task and links to open or unbind it. |
| `/unbind` | Stop routing regular Telegram messages into that conversation. |
| `/help` | Display the commands available to the paired user. |

Once bound, normal Telegram messages go to the selected **active** task. Completed/cancelled tasks automatically become unavailable as chat targets; Local never guesses a conversation when none is selected. A Telegram photo/document sent as a mapped task reply can be downloaded to the configured local folder and passed to the agent by path; Equinox Browser does not re-upload it to ChatGPT.

The task remains in Control Center even if a fresh-chat handoff or browser action fails. To recover, open **Control Center → Tasks** and read the task's current state; do not blindly resend a message whose delivery is ambiguous.

## Task Capsules, Auto Continue & recovery

A Task Capsule stores a **bounded objective, completed work, next steps and safe references**. It is not a full transcript archive. A long-running agent can explicitly arm one Auto Continue after saving its checkpoint; the chain limit is configurable in Control Center. Fresh Chat Resume can move that task to a **new** ChatGPT conversation without copying the history.

Every send is guarded by the exact task/browser/conversation identity. If sending becomes uncertain, Equinox Local prevents an automatic second attempt. Your own typing, a new message, a cancelled task or **Emergency Stop** takes precedence over unattended continuation.

These behaviors depend on a connected [Equinox Browser](browser.md) and the corresponding controls being enabled in the selected Chrome profile. Telegram remote control can be turned off in Control Center without disabling outbound status notifications.

## Privacy & troubleshooting

- The Telegram bot token, pairing identity and inbound queue remain in **local private application state**. They are not repository configuration.
- Only the confirmed **private** chat is eligible; group, channel and unpaired messages are ignored.
- Commands such as restart and Emergency Stop require explicit confirmation when applicable.
- If a chat reply remains unsent, check Browser connection, the bound task, and the exact conversation before retrying. Use **Control Center → Tasks** for state-safe recovery.
- Telegram is an external service: messages and attachments intentionally sent through its servers are subject to Telegram's own privacy policies.

See [the security model](security-model.md), [Browser details](browser.md) and [architecture](architecture.md).
