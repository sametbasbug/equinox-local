# Connect Equinox Local through OpenAI Secure MCP Tunnel

Equinox Local is a local MCP runtime. ChatGPT does not connect directly to `localhost`, so a managed Equinox Local install uses OpenAI Secure MCP Tunnel as its remote transport without exposing an inbound port on the user’s Mac or Windows PC.

## What you need

**Free and paid ChatGPT users can add their own custom MCP plugin directly under [Plugins](https://chatgpt.com/plugins).** There is no developer mode or separate ChatGPT setting to enable first. Equinox Local still needs a Secure MCP Tunnel and a restricted OpenAI Platform runtime key to connect the local computer.

You will need two separate OpenAI Platform values:

- a **Tunnel ID** such as `tunnel_0123456789abcdef0123456789abcdef`;
- a **Runtime API key** whose principal has **Tunnels: Read + Use** for that tunnel.

The runtime key is not the Tunnel ID. Do not use an admin key as the long-lived Equinox Local runtime key.

## 1. Create the tunnel

Open:

- <https://platform.openai.com/settings/organization/tunnels>

Create a tunnel and scope it to the ChatGPT workspace that should use Equinox Local. Copy the resulting `tunnel_…` value.

Equinox Local validates tunnel IDs as `tunnel_` followed by 32 lowercase hexadecimal characters.

A tunnel can exist in OpenAI Platform without appearing in ChatGPT if it was created for the wrong workspace or the relevant user/group does not have permission to use it.

## 2. Create the runtime API key

Open:

- <https://platform.openai.com/settings/organization/api-keys>

Create a **Restricted** runtime API key. Grant only:

- **Tunnels: Read**
- **Tunnels: Use**

`Use` is required for the tunnel client to attach to and run the tunnel. `Manage` is only for tunnel administration and is not required by Equinox Local's long-lived runtime.

Keep the key private. Equinox Local never needs an OpenAI admin key for normal managed operation.

## 3. Save the values in Control Center

After the managed Equinox Local installation starts, open:

- <http://127.0.0.1:24891/>

Under **Connect to ChatGPT**:

1. paste the Tunnel ID;
2. paste the Runtime API key;
3. choose **Save & connect**.

Equinox Local stores the runtime key in its per-user Application Support area with platform-appropriate private state protections (`0600` on macOS or current-user ACLs on Windows). The Control Center API never returns the secret after it has been saved.

The transport configuration stores the Tunnel ID separately and Local schedules a controlled restart. If tunnel startup fails, the supervisor falls back to local-only Control Center mode instead of exposing a different transport.

On a genuinely fresh managed install, this is only the tunnel step of the dedicated **Setup Mode**. Setup then requires the human to add a custom Equinox Local MCP plugin through ChatGPT Plugins using the corresponding tunnel, install/consent/enable **Equinox Browser** in the personal Chrome profile, and send the provided verification prompt. Control Center stays locked to Setup (plus uninstall) until a real ChatGPT MCP tool call reaches the Mac. Successful completion is persisted so later tunnel/browser outages are ordinary attention states rather than another first-run lock.

## 4. Connect the same tunnel in ChatGPT

Open **[ChatGPT → Plugins](https://chatgpt.com/plugins)** and choose **Add custom MCP server** (**Özel MCP sunucusu ekle**). No developer mode or account setting needs to be enabled first.

1. Select **Tunnel** (**Tünel**). The Tunnel ID is populated automatically in this flow; **do not paste it a second time**.
2. Choose **Authentication → No authentication** (**Kimlik doğrulama → Kimlik doğrulama yok**) and save your custom plugin.
3. Scan or refresh its MCP tools once Equinox Local has connected.

The restricted Runtime API key stays **only in Equinox Local Setup**, not in the ChatGPT plugin form.

The Local runtime and the ChatGPT app must point to the same tunnel.

ChatGPT provides custom MCP plugin creation to both Free and paid users. Plugin publishing and individual tool permissions are separate from the local tunnel credentials and may change with the ChatGPT product; adding a private plugin requires no paid upgrade or developer-mode toggle.

## Network model

Secure MCP Tunnel is outbound-only from the Equinox Local machine to OpenAI's tunnel control plane over HTTPS. You do not need to:

- open an inbound router/firewall port;
- expose `127.0.0.1:24891`;
- publish the local MCP stdio process on the internet;
- configure a public reverse proxy for Equinox Local.

Control Center remains loopback-only.

## Troubleshooting

### The tunnel is not visible in ChatGPT

Check that:

- the tunnel was created with the correct ChatGPT workspace scope;
- the relevant principal has Tunnels Read + Use;
- the same Tunnel ID is being used on both sides;
- a newly created tunnel has had a short amount of time to propagate.

### Control Center says the saved tunnel needs attention

Re-enter the Runtime API key in **Connect to ChatGPT**. A malformed or unreadable saved transport fails closed and Local continues in local-only mode so you can repair it from Control Center.

### Local saved the tunnel but ChatGPT still cannot scan tools

Confirm that Equinox Local has restarted into tunnel mode, then refresh the ChatGPT app/connector tool scan. If the app was created before the tunnel was ready, refresh the app rather than changing Local's filesystem configuration manually.

## Upstream references

- OpenAI tunnel management: <https://platform.openai.com/settings/organization/tunnels>
- OpenAI runtime API keys: <https://platform.openai.com/settings/organization/api-keys>
- ChatGPT app/connector settings: <https://chatgpt.com/plugins>
- OpenAI Secure MCP Tunnel client: <https://github.com/openai/tunnel-client>
