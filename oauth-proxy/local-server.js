/**
 * Local OAuth redirect proxy for development.
 *
 * Slack requires HTTPS redirect URIs, so we can't use vscode:// directly.
 * This tiny HTTP server acts as the middleman:
 *
 *   1. Slack redirects to: http://localhost:3456/slack-callback?code=xyz&state=abc
 *   2. This server redirects to: vscode://jerrychaitea.conduit/slack-callback?code=xyz&state=abc
 *   3. VS Code catches the vscode:// URI and completes the OAuth flow
 *
 * Usage:
 *   1. Run this server:  node oauth-proxy/local-server.js
 *   2. Run ngrok:         ngrok http 3456
 *   3. Copy the ngrok HTTPS URL (e.g. https://abc123.ngrok-free.app)
 *   4. Add that URL as the Slack OAuth redirect: https://abc123.ngrok-free.app/slack-callback
 *   5. Set businessContext.slack.oauthProxyUrl in VS Code settings to the ngrok URL
 *   6. Click "Connect Slack" in Conduit — the flow goes through ngrok → this server → VS Code
 */

const http = require("http");

const PORT = 3456;
const VSCODE_URI_BASE = "vscode://jerrychaitea.conduit/slack-callback";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/slack-callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      res.writeHead(200, { "Content-Type": "tengrok http 3456xt/html" });
      res.end(`<h2>Slack authorization failed</h2><p>Error: ${error}</p>`);
      return;
    }

    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end("<h2>Missing authorization code</h2>");
      return;
    }

    // Build the vscode:// URI with the OAuth params
    const params = new URLSearchParams();
    params.set("code", code);
    if (state) params.set("state", state);
    const vscodeUri = `${VSCODE_URI_BASE}?${params}`;

    // Redirect the browser to VS Code's URI handler.
    // We use a 302 redirect AND a meta refresh + JS fallback because some
    // browsers block vscode:// redirects from HTTP 302s.
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <meta http-equiv="refresh" content="0;url=${vscodeUri}">
  <title>Redirecting to VS Code...</title>
</head>
<body>
  <h2>Redirecting to VS Code...</h2>
  <p>If VS Code doesn't open automatically, <a href="${vscodeUri}">click here</a>.</p>
  <script>window.location.href = ${JSON.stringify(vscodeUri)};</script>
</body>
</html>`);
    return;
  }

  // Health check / root
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Conduit OAuth proxy is running. Waiting for Slack callback...");
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`OAuth proxy running at http://localhost:${PORT}`);
  console.log(`Waiting for Slack callback at http://localhost:${PORT}/slack-callback`);
  console.log("");
  console.log("Next steps:");
  console.log(`  1. Run: ngrok http ${PORT}`);
  console.log("  2. Copy the HTTPS URL from ngrok");
  console.log("  3. Add it as Slack OAuth redirect URL: <ngrok-url>/slack-callback");
  console.log("  4. Set businessContext.slack.oauthProxyUrl to the ngrok URL in VS Code settings");
});
