# Slack Setup Guide

Conduit supports two ways to connect Slack:

- **OAuth (recommended)** — Click "Connect Slack" in the UI, authorize in browser, done.
- **Manual token** — Create a bot token manually and paste it into settings.

## Developer Setup (One-Time)

These steps are for the extension developer (you). End users only click "Connect Slack".

### Step 1: Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **"Create New App"** → **"From scratch"**
3. **App Name:** "Conduit" (or any name)
4. **Workspace:** Select your test workspace
5. Click **"Create App"**

### Step 2: Configure OAuth & Permissions

1. In the left sidebar, click **"OAuth & Permissions"**
2. Under **"Redirect URLs"**, add your proxy URL:
   - Development: your ngrok HTTPS URL + `/slack-callback`
   - Production: your Cloudflare Worker URL + `/slack-callback`
3. Under **"Bot Token Scopes"**, add these scopes:
   - `channels:history` - View messages in public channels
   - `channels:read` - View basic channel info
   - `groups:history` - View messages in private channels
   - `groups:read` - View private channel info
   - `im:history` - View messages in DMs
   - `im:read` - View DM info
   - `mpim:history` - View messages in group DMs
   - `mpim:read` - View group DM info
   - `users:read` - View people in workspace

### Step 3: Configure VS Code Settings

Add your Slack app credentials to `.vscode/settings.json`:

```json
{
  "businessContext.slack.clientId": "YOUR_CLIENT_ID",
  "businessContext.slack.clientSecret": "YOUR_CLIENT_SECRET",
  "businessContext.slack.oauthProxyUrl": "https://your-proxy-url.ngrok-free.app"
}
```

## OAuth Proxy Setup

Slack requires HTTPS redirect URIs, but VS Code uses `vscode://` URIs. The OAuth
proxy bridges this gap — it receives the callback from Slack over HTTPS, then
redirects the browser to `vscode://` which VS Code catches.

### Development: ngrok

1. Start the local proxy server:
   ```bash
   node oauth-proxy/local-server.js
   ```

2. In another terminal, start ngrok:
   ```bash
   ngrok http 3456
   ```

3. Copy the HTTPS URL from ngrok (e.g. `https://abc123.ngrok-free.app`)

4. Add the redirect URL in your Slack app settings:
   `https://abc123.ngrok-free.app/slack-callback`

5. Set the proxy URL in VS Code settings:
   ```json
   {
     "businessContext.slack.oauthProxyUrl": "https://abc123.ngrok-free.app"
   }
   ```

6. Press F5 to launch Extension Dev Host, click "Connect Slack" — done!

### Production: Cloudflare Workers (Free)

1. Install wrangler: `npm install -g wrangler`
2. Login: `wrangler login`
3. Deploy:
   ```bash
   wrangler deploy oauth-proxy/cloudflare-worker.js --name conduit-oauth
   ```
4. Your URL: `https://conduit-oauth.<account>.workers.dev`
5. Add redirect URL in Slack app: `https://conduit-oauth.<account>.workers.dev/slack-callback`
6. Update VS Code settings with the production URL

## Manual Token Setup (Alternative)

If you prefer not to use OAuth, you can create a bot token manually:

1. Follow Steps 1-2 above to create a Slack app with scopes
2. Click **"Install to Workspace"** → **"Allow"**
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
4. In VS Code settings, set `businessContext.slack.userToken` to the token

## End User Experience (OAuth)

1. User installs Conduit extension
2. User opens Conduit chat panel
3. User clicks **"Connect"** next to Slack
4. Browser opens Slack authorization page
5. User clicks **"Allow"**
6. Browser redirects back → VS Code opens → Slack connected!

## Troubleshooting

### OAuth redirect fails

- Make sure the proxy server is running (dev) or deployed (prod)
- Verify the redirect URL in Slack app matches your proxy URL exactly
- Check that `businessContext.slack.oauthProxyUrl` is set correctly

### "Not authenticated" Error

- Make sure you copied the **Bot User OAuth Token** (starts with `xoxb-`)
- Not the User OAuth Token or other tokens

### "No results found"

- Check that your bot has been added to channels you want to search
- In Slack, type `/invite @YourBotName` in any channel

## Security Note

- Never commit `.vscode/settings.json` with credentials to git
- The OAuth proxy only forwards auth codes — it never sees or stores tokens
- Auth codes are one-time use and expire in 10 minutes
- Bot tokens are stored encrypted in VS Code SecretStorage (per-user)
