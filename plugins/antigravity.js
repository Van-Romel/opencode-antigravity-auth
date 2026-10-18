import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

// Public Google Cloud Code / Antigravity Desktop OAuth Client credentials issued by Google LLC.
// NOTE: This is NOT a personal API key, user token, or private secret. It is Google's official public
// client identifier used by VS Code / IDE tools to initiate the standard OAuth 2.0 PKCE consent screen.
const CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || "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";
const CONFIG_PATH = join(homedir(), ".config/opencode/antigravity-accounts.json");
const SETTINGS_PATH = join(homedir(), ".config/opencode/antigravity.json");

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
  if (process.platform === "win32") {
    try {
      const out = execSync(`reg query HKCU\\Environment /v ${name}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      const line = out.split(/\r?\n/).find(l => l.includes(name));
      if (line) {
        const val = line.trim().split(/\s+/).pop();
        if (val) return val.trim();
      }
    } catch {}
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
    return null; // Contas por API Key não necessitam de Bearer token
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
  } catch (e) {
    // Falha transitória não bloqueia
  }

  return cached ? cached.quota : { remainingFraction: 1.0, resetTime: null };
}

function formatCountdown(ms) {
  if (ms <= 0) return "agora";
  const totalSeconds = Math.ceil(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}min`;
  }
  return `${minutes}min`;
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

function createAntigravityTransformStream() {
  let buffer = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        const json = line.slice(5).trim();
        if (!json) {
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        try {
          const parsed = JSON.parse(json);
          if (parsed && parsed.response !== undefined) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed.response)}\n`));
          } else {
            controller.enqueue(encoder.encode(line + "\n"));
          }
        } catch {
          controller.enqueue(encoder.encode(line + "\n"));
        }
      }
    },
    flush(controller) {
      if (buffer) {
        if (buffer.startsWith("data:")) {
          const json = buffer.slice(5).trim();
          try {
            const parsed = JSON.parse(json);
            if (parsed && parsed.response !== undefined) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(parsed.response)}\n`));
              return;
            }
          } catch {}
        }
        controller.enqueue(encoder.encode(buffer));
      }
    }
  });
}

function extractUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input === "object") {
    if ("href" in input && typeof input.href === "string") return input.href;
    if ("url" in input && typeof input.url === "string") return input.url;
  }
  return String(input || "");
}

let isPatched = false;
function patchFetch() {
  if (isPatched) return;
  isPatched = true;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (input, init) {
    const url = extractUrl(input);

    if (url.includes("generativelanguage.googleapis.com")) {
      const match = url.match(/\/models\/([^:]+):(\w+)/);
      if (match) {
        const [, rawModel, rawAction] = match;
        const actualModel = resolveModel(rawModel);
        const isStreaming = rawAction === "streamGenerateContent" || url.includes("alt=sse");

        const settings = loadSettings();
        const thresholdPercent = settings.soft_quota_threshold_percent || DEFAULT_THRESHOLD_PERCENT;
        const minRemainingFraction = (100 - thresholdPercent) / 100;

        const storage = loadAccounts();
        const accounts = storage.accounts || [];

        // Filtra preferencialmente contas OAuth com refreshToken
        const oauthAccounts = accounts.filter(a => a.refreshToken);
        const candidates = oauthAccounts.length > 0 ? oauthAccounts : accounts;

        if (candidates.length > 0) {
          let selectedAccount = null;
          let accessToken = null;
          let selectedIndex = 0;

          for (let i = 0; i < candidates.length; i++) {
            const acc = candidates[i];
            try {
              const token = await getValidAccessToken(acc, i);
              const quota = await fetchAccountQuota(acc, i, token);
              if (quota.remainingFraction > minRemainingFraction) {
                selectedAccount = acc;
                accessToken = token;
                selectedIndex = i;
                break;
              }
            } catch (err) {
              // Tenta próxima conta
            }
          }

          if (!selectedAccount) {
            // Se todas estiverem acima de 80%, usa a primeira válida
            for (let i = 0; i < candidates.length; i++) {
              try {
                const token = await getValidAccessToken(candidates[i], i);
                selectedAccount = candidates[i];
                accessToken = token;
                selectedIndex = i;
                break;
              } catch {}
            }
          }

          if (selectedAccount && accessToken) {
            let originalBody = {};
            if (typeof init?.body === "string" && init.body) {
              try { originalBody = JSON.parse(init.body); } catch {}
            }

            const wrappedBody = {
              project: selectedAccount.projectId || DEFAULT_PROJECT_ID,
              model: actualModel,
              request: originalBody
            };

            const headers = new Headers(init?.headers || {});
            headers.set("Authorization", `Bearer ${accessToken}`);
            headers.set("Content-Type", "application/json");
            headers.set("User-Agent", PLATFORM_HEADERS["User-Agent"]);
            headers.set("X-Goog-Api-Client", PLATFORM_HEADERS["X-Goog-Api-Client"]);
            headers.set("Client-Metadata", PLATFORM_HEADERS["Client-Metadata"]);
            headers.delete("x-goog-user-project");
            headers.delete("x-api-key");
            headers.delete("x-goog-api-key");

            for (const baseEndpoint of ANTIGRAVITY_ENDPOINTS) {
              try {
                const targetEndpoint = `${baseEndpoint}/v1internal:${rawAction}${isStreaming ? "?alt=sse" : ""}`;
                const res = await originalFetch(targetEndpoint, {
                  method: "POST",
                  headers,
                  body: JSON.stringify(wrappedBody),
                  signal: init?.signal
                });

                if (res.ok) {
                  if (isStreaming && res.body) {
                    const transformStream = createAntigravityTransformStream();
                    const transformedBody = res.body.pipeThrough(transformStream);
                    return new Response(transformedBody, {
                      status: res.status,
                      statusText: res.statusText,
                      headers: res.headers
                    });
                  } else {
                    const text = await res.text();
                    try {
                      const parsed = JSON.parse(text);
                      if (parsed && parsed.response !== undefined) {
                        return new Response(JSON.stringify(parsed.response), {
                          status: res.status,
                          statusText: res.statusText,
                          headers: res.headers
                        });
                      }
                    } catch {}
                    return new Response(text, {
                      status: res.status,
                      statusText: res.statusText,
                      headers: res.headers
                    });
                  }
                }
              } catch {}
            }
          }
        }
      }
    }

    return originalFetch(input, init);
  };
}

// Aplica o patch imediatamente no carregamento do módulo
patchFetch();

export default {
  id: "antigravity",
  setup(ctx) {
    patchFetch();
  }
};
