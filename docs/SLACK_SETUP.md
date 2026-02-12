# Slack Setup Guide

This guide shows you how to set up Slack integration with Conduit using a bot token.

## Step 1: Create a Slack App

1. Go to https://api.slack.com/apps
2. Click **"Create New App"** → **"From scratch"**
3. **App Name:** Enter any name (e.g., "Conduit Bot")
4. **Workspace:** Select your Slack workspace
5. Click **"Create App"**

## Step 2: Add Bot Token Scopes

1. In the left sidebar, click **"OAuth & Permissions"**
2. Scroll down to **"Bot Token Scopes"**
3. Click **"Add an OAuth Scope"** and add these scopes:
   - `channels:read` - View basic channel info
   - `groups:read` - View private channel info
   - `im:read` - View DM info
   - `mpim:read` - View group DM info
   - `search:read` - Search messages and files
   - `users:read` - View people in workspace

## Step 3: Install App to Workspace

1. Scroll up to **"OAuth Tokens for Your Workspace"**
2. Click **"Install to Workspace"**
3. Review permissions and click **"Allow"**
4. You'll see a **"Bot User OAuth Token"** starting with `xoxb-`
5. Click **"Copy"** to copy the token

## Step 4: Add Token to VS Code Settings

### Option A: Using VS Code Settings UI

1. In VS Code, press `Cmd+,` (macOS) or `Ctrl+,` (Windows/Linux)
2. Search for "businessContext.slack.userToken"
3. Paste your bot token in the field

### Option B: Using settings.json

1. In VS Code, press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
2. Type "Preferences: Open User Settings (JSON)"
3. Add this line (replace with your actual token):

```json
{
  "businessContext.slack.userToken": "xoxb-your-token-here"
}
```

## Step 5: Test the Connection

1. Open Conduit chat panel
2. Try a search query: "find messages about deployment"
3. Conduit should search your Slack workspace and return results!

## Troubleshooting

### "Not authenticated" Error

- Make sure you copied the **Bot User OAuth Token** (starts with `xoxb-`)
- Not the User OAuth Token or other tokens

### "No results found"

- Check that your bot has been added to channels you want to search
- In Slack, type `/invite @YourBotName` in any channel

### "Permission denied"

- Go back to OAuth & Permissions in the Slack app settings
- Make sure all 6 scopes are added
- Reinstall the app to workspace if you added scopes after installation

## Security Note

⚠️ **Keep your bot token secret!**
- Don't commit it to git
- Don't share it publicly
- Treat it like a password

The token gives access to your Slack workspace data, so keep it secure.
