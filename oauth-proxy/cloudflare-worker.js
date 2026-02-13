/**
 * Cloudflare Worker — production OAuth redirect proxy for Conduit.
 *
 * Deploy this as a Cloudflare Worker to get a permanent HTTPS URL for
 * Slack OAuth redirects. It does one thing: receive the OAuth callback
 * from Slack and redirect the browser to the vscode:// URI handler.
 *
 * Deployment:
 *   1. Install wrangler:  npm install -g wrangler
 *   2. Login:             wrangler login
 *   3. Deploy:            wrangler deploy oauth-proxy/cloudflare-worker.js --name conduit-oauth
 *   4. Your URL will be:  https://conduit-oauth.<your-account>.workers.dev
 *   5. Add redirect URL in Slack app: https://conduit-oauth.<your-account>.workers.dev/slack-callback
 *   6. Set businessContext.slack.oauthProxyUrl to the worker URL in VS Code settings
 *
 * Cost: $0 (Cloudflare Workers free tier = 100K requests/day)
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/slack-callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        return new Response(
          `<h2>Slack authorization failed</h2><p>Error: ${error}</p>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }

      if (!code) {
        return new Response("<h2>Missing authorization code</h2>", {
          status: 400,
          headers: { "Content-Type": "text/html" },
        });
      }

      // Build vscode:// URI with OAuth params
      const params = new URLSearchParams();
      params.set("code", code);
      if (state) params.set("state", state);
      const vscodeUri = `vscode://jerrychaitea.conduit/slack-callback?${params}`;

      // Return HTML that redirects to VS Code. We use meta refresh + JS
      // because some browsers block vscode:// from HTTP 302 redirects.
      return new Response(
        `<!DOCTYPE html>
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
</html>`,
        { headers: { "Content-Type": "text/html" } }
      );
    }

    // Health check
    if (url.pathname === "/") {
      return new Response("Conduit OAuth proxy is running.", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};
