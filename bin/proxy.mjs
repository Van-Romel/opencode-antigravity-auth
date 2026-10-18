import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const CONFIG_PATH = join(homedir(), ".config/opencode/antigravity-accounts.json");
const PROXY_PORT = 45122;

const PLATFORM_HEADERS = {
  "User-Agent": "antigravity/1.11.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": JSON.stringify({ ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }),
};

function getRefreshToken() {
  if (existsSync(CONFIG_PATH)) {
    const data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const acc = data.accounts?.find(a => a.refreshToken);
    if (acc) return acc.refreshToken;
  }
  return null;
}

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) return cachedToken;
  const refreshToken = getRefreshToken();
  if (!refreshToken) throw new Error("No refresh token found");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  if (!res.ok) throw new Error("Failed to refresh token: " + (await res.text()));
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + ((data.expires_in || 3600) * 1000);
  return cachedToken;
}

function resolveModel(rawModel) {
  let model = rawModel || "gemini-3-flash";
  if (model.startsWith("antigravity-")) model = model.replace("antigravity-", "");
  if (model.startsWith("gemini-3.8-flash")) model = "gemini-3-flash";
  return model;
}

const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://127.0.0.1:${PROXY_PORT}`);
    const match = reqUrl.pathname.match(/\/models\/([^:]+):(\w+)/);
    
    if (!match) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const [, rawModel, rawAction] = match;
    const actualModel = resolveModel(rawModel);
    const isStreaming = rawAction === "streamGenerateContent" || reqUrl.searchParams.get("alt") === "sse";

    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bodyStr = Buffer.concat(chunks).toString("utf-8");
    let originalBody = {};
    try { originalBody = JSON.parse(bodyStr); } catch {}

    const accessToken = await getAccessToken();

    const wrappedBody = {
      project: "aicode-consumers",
      model: actualModel,
      request: originalBody
    };

    const targetUrl = `https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:${rawAction}${isStreaming ? "?alt=sse" : ""}`;

    const googleRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...PLATFORM_HEADERS
      },
      body: JSON.stringify(wrappedBody)
    });

    if (!googleRes.ok) {
      const errText = await googleRes.text();
      res.writeHead(googleRes.status, { "Content-Type": "application/json" });
      res.end(errText);
      return;
    }

    if (isStreaming) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      });

      const reader = googleRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) {
            res.write(line + "\n");
            continue;
          }
          const jsonStr = line.slice(5).trim();
          if (!jsonStr) {
            res.write(line + "\n");
            continue;
          }
          try {
            const parsed = JSON.parse(jsonStr);
            if (parsed && parsed.response !== undefined) {
              res.write(`data: ${JSON.stringify(parsed.response)}\n`);
            } else {
              res.write(line + "\n");
            }
          } catch {
            res.write(line + "\n");
          }
        }
      }
      res.end();
    } else {
      const text = await googleRes.text();
      let finalJson = text;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.response !== undefined) {
          finalJson = JSON.stringify(parsed.response);
        }
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(finalJson);
    }
  } catch (err) {
    console.error("Proxy error:", err.message);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message } }));
  }
});

server.listen(PROXY_PORT, "127.0.0.1", () => {
  console.log(`Antigravity Local Proxy running on http://127.0.0.1:${PROXY_PORT}`);
});
