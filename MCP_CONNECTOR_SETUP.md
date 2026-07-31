# Wiring PXBOT into Claude as a live connector

This turns your local PXBOT server into a connector Claude can call live, in
chat, from any device — while your PC keeps running the actual TradeLocker
connection. Nothing here places, modifies, or closes trades: every tool is
read-only market data (candles, quote, session context, positions-view).

## 1. Install the new dependency

```
cd path\to\PXBOT
npm install
```

This pulls in `@modelcontextprotocol/sdk` and `zod`, used only by the new
`/mcp` endpoint. The rest of the app is unchanged.

## 2. Start the server as usual

Run `PXBOT.bat` (or `node server.js`). On startup the console now also prints:

```
Claude MCP connector endpoint (for the tunnel):
  POST http://127.0.0.1:8899/mcp?token=<a long random token>
```

That token is generated once and saved to `mcp_token.json` (never committed —
it's in `.gitignore`). Anyone with your tunnel URL *and* this token can read
your live quotes/candles, so don't post the full URL+token publicly.

## 3. Expose port 8899 with a free, stable tunnel (ngrok)

You want a URL that doesn't change every restart, so claude.ai's connector
config doesn't need updating constantly.

1. Create a free account at ngrok.com, install the ngrok CLI, run
   `ngrok config add-authtoken <your token>` (from your ngrok dashboard).
2. In the ngrok dashboard, claim your one free static domain (Domains →
   Create Domain) — you'll get something like `your-name-1234.ngrok-free.app`.
3. Start the tunnel: `ngrok http --url=your-name-1234.ngrok-free.app 8899`
4. Leave that window open alongside the PXBOT server window. Your MCP
   endpoint is now reachable at:
   `https://your-name-1234.ngrok-free.app/mcp?token=<your token>`

(No ngrok account, don't mind re-pasting the URL occasionally? Use
`cloudflared tunnel --url http://localhost:8899` instead — zero signup, but
the `trycloudflare.com` address changes every time you restart it.)

## 4. Add it as a custom connector on claude.ai

1. claude.ai → Settings → Connectors → Add custom connector.
2. Name it something like `PXBOT TradeLocker`.
3. URL: `https://your-name-1234.ngrok-free.app/mcp`
4. If it offers a header/auth field, set header `Authorization` to
   `Bearer <your token>`. If it only takes a bare URL, append
   `?token=<your token>` to the URL in step 3 instead.
5. Save, then enable it for this chat (connector toggle in the chat's tool
   picker).

## 5. Tell Claude to check it

Once enabled, say something like "check the PXBOT connector" in chat — Claude
will call `get_health` to confirm it can see your live TradeLocker connection,
then it's ready to read `get_candles`, `get_quote`, `get_market_context`,
`get_deep_context`, and `get_positions` for real signal analysis.

## Rotating or revoking the token

Delete `mcp_token.json` and restart the server — a new token is generated and
printed on startup. Update the connector's URL/header on claude.ai to match.
