import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// Public Google Cloud Code / Antigravity Desktop OAuth Client credentials issued by Google LLC.
// NOTE: This is NOT a personal API key, user token, or private secret. It is Google's official public
// client identifier used by VS Code / IDE tools to initiate the standard OAuth 2.0 PKCE consent screen.
const CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || "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";
const CONFIG_PATH = join(homedir(), ".config/opencode/antigravity-accounts.json");
const SETTINGS_PATH = join(homedir(), ".config/opencode/antigravity.json");
const PROXY_PORT = 45122;

// Limite de segurança de cota (80% de uso -> <= 20% restante)
const DEFAULT_THRESHOLD_PERCENT = 80;
const DEFAULT_PROJECT_ID = "aicode-consumers";

// Endpoints oficiais do Antigravity / Cloud Code (com fallback de sandbox daily)
const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

const PLATFORM_HEADERS = {
  "User-Agent": "antigravity/1.11.5 windows/amd64",
  "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
  "Client-Metadata": JSON.stringify({ ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" }),
};

// Variáveis de ambiente suportadas (padrão de mercado + aliases amigáveis)
const OAUTH_TOKEN_ENV_VARS = [
  "ANTIGRAVITY_REFRESH_TOKEN",
  "OPENCODE_ANTIGRAVITY_TOKEN",
  "APIKEYGOOGLEFOROPENCODE",
];

const API_KEY_ENV_VARS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENCODE_GEMINI_KEY",
];

// Cache de tokens em memória: accountIndex -> { access_token, expires_at }
const tokenCache = new Map();

// Cache de checagem de cota para evitar requests repetitivos a cada segundo
const quotaCache = new Map();
const QUOTA_CACHE_TTL_MS = 120_000; // 2 minutos

function loadSettings() {
  try {
    if (existsSync(SETTINGS_PATH)) {
      return JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    }
  } catch {}
  return { soft_quota_threshold_percent: DEFAULT_THRESHOLD_PERCENT };
}

function resolveEnv(name) {
  if (process.env[name] && process.env[name].trim()) {
    return process.env[name].trim();
  }
  return null;
}

function resolveFirstEnv(names) {
  for (const name of names) {
    const val = resolveEnv(name);
    if (val) return val;
  }
  return null;
}

function loadAccounts() {
  let data = { version: 4, accounts: [], activeIndex: 0 };
  if (existsSync(CONFIG_PATH)) {
    try {
      data = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {}
  }
  if (!Array.isArray(data.accounts)) data.accounts = [];

  // Sincronizar com variáveis de ambiente (se fornecidas)
  const envRefreshToken = resolveFirstEnv(OAUTH_TOKEN_ENV_VARS);
  if (envRefreshToken) {
    const existing = data.accounts.find(a => a.refreshToken === envRefreshToken || a.email === "conta-oauth-env");
    if (!existing) {
      data.accounts.unshift({
        email: "conta-oauth-env",
        refreshToken: envRefreshToken,
        projectId: DEFAULT_PROJECT_ID,
        addedAt: Date.now(),
        lastUsed: Date.now(),
        quota: { claude: { remainingFraction: 1.0 }, gemini: { remainingFraction: 1.0 } }
      });
    } else {
      existing.refreshToken = envRefreshToken;
    }
  }

  const envApiKey = resolveFirstEnv(API_KEY_ENV_VARS);
  if (envApiKey) {
    const existing = data.accounts.find(a => a.apiKey === envApiKey || a.email === "gemini-api-key-env");
    if (!existing) {
      data.accounts.push({
        email: "gemini-api-key-env",
        apiKey: envApiKey,
        projectId: "gemini-api-key",
        addedAt: Date.now(),
        lastUsed: Date.now(),
        quota: { gemini: { remainingFraction: 1.0 } }
      });
    } else {
      existing.apiKey = envApiKey;
    }
  }

  return data;
}

function saveAccounts(data) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error("[Antigravity] Falha ao salvar antigravity-accounts.json:", err.message);
  }
}

async function getValidAccessToken(account, index) {
  if (account.apiKey) {
    return null;
  }

  const cached = tokenCache.get(index);
  const now = Date.now();
  if (cached && cached.expires_at > now + 60_000) {
    return cached.access_token;
  }

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: account.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`[Antigravity] Falha ao renovar token para conta ${account.email || index + 1}: ${errorText}`);
  }

  const data = await res.json();
  const expiresAt = now + ((data.expires_in || 3600) * 1000);
  tokenCache.set(index, { access_token: data.access_token, expires_at: expiresAt });
  return data.access_token;
}

async function fetchAccountQuota(account, index, accessToken) {
  if (account.apiKey) {
    return { remainingFraction: 1.0, resetTime: null };
  }

  const cached = quotaCache.get(index);
  const now = Date.now();
  if (cached && (now - cached.timestamp) < QUOTA_CACHE_TTL_MS) {
    return cached.quota;
  }

  try {
    const res = await fetch("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...PLATFORM_HEADERS,
      },
      body: JSON.stringify({ project: account.projectId || DEFAULT_PROJECT_ID }),
    });

    if (res.ok) {
      const data = await res.json();
      let lowestRemaining = 1.0;
      let earliestReset = null;

      if (Array.isArray(data.buckets)) {
        for (const bucket of data.buckets) {
          const rem = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : 1.0;
          if (rem < lowestRemaining) {
            lowestRemaining = rem;
          }
          if (bucket.resetTime) {
            const rt = Date.parse(bucket.resetTime);
            if (!isNaN(rt) && (!earliestReset || rt < earliestReset)) {
              earliestReset = rt;
            }
          }
        }
      }

      const quotaResult = {
        remainingFraction: lowestRemaining,
        resetTime: earliestReset ? new Date(earliestReset).toISOString() : null,
      };

      quotaCache.set(index, { timestamp: now, quota: quotaResult });
      return quotaResult;
    }
  } catch (e) {}

  return cached ? cached.quota : { remainingFraction: 1.0, resetTime: null };
}

function resolveModel(rawModel) {
  let model = rawModel || "gemini-3-flash";
  if (model.startsWith("antigravity-")) {
    model = model.replace("antigravity-", "");
  }
  if (model.startsWith("gemini-3.8-flash")) {
    model = "gemini-3-flash";
  }
  return model;
}

// Inicia o proxy local no loopback (127.0.0.1:45122) para interceptar chamadas nativamente
function startProxyServer() {
  try {
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

        // Ler corpo da requisição do OpenCode
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bodyStr = Buffer.concat(chunks).toString("utf-8");
        let originalBody = {};
        try { originalBody = JSON.parse(bodyStr); } catch {}

        const storage = loadAccounts();
        const accounts = storage.accounts || [];
        const oauthAccounts = accounts.filter(a => a.refreshToken);
        const candidates = oauthAccounts.length > 0 ? oauthAccounts : accounts;

        let selectedAccount = null;
        let accessToken = null;
        for (let i = 0; i < candidates.length; i++) {
          try {
            const token = await getValidAccessToken(candidates[i], i);
            selectedAccount = candidates[i];
            accessToken = token;
            break;
          } catch {}
        }

        if (!selectedAccount || !accessToken) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "No valid Google Antigravity account found. Run auth-cli.mjs login." } }));
          return;
        }

        const wrappedBody = {
          project: selectedAccount.projectId || DEFAULT_PROJECT_ID,
          model: actualModel,
          request: originalBody
        };

        for (const baseEndpoint of ANTIGRAVITY_ENDPOINTS) {
          try {
            const targetUrl = `${baseEndpoint}/v1internal:${rawAction}${isStreaming ? "?alt=sse" : ""}`;
            const googleRes = await fetch(targetUrl, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                ...PLATFORM_HEADERS
              },
              body: JSON.stringify(wrappedBody)
            });

            if (googleRes.ok) {
              if (isStreaming && googleRes.body) {
                res.writeHead(200, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive"
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
                return;
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
                return;
              }
            }
          } catch {}
        }

        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Failed to connect to Google Antigravity endpoints" } }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });

    server.once("error", () => {});
    server.listen(PROXY_PORT, "127.0.0.1", () => {});
  } catch {}
}

startProxyServer();

export default {
  id: "antigravity",
  setup(ctx) {
    startProxyServer();
    if (ctx?.session?.hook) {
      try {
        ctx.session.hook("http.request", async () => {});
        ctx.session.hook("http.response", async () => {});
      } catch {}
    }
    return () => {};
  }
};
