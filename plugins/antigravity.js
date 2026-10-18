import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = "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";
const CONFIG_PATH = join(homedir(), ".config/opencode/antigravity-accounts.json");
const SETTINGS_PATH = join(homedir(), ".config/opencode/antigravity.json");

// Limite de segurança de cota (80% de uso -> <= 20% restante)
const DEFAULT_THRESHOLD_PERCENT = 80;
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";

// Headers consistentes com o host real (elimina detecção de anomalia TCP / User-Agent no Google)
function getHostPlatformHeaders() {
  const isWin = process.platform === "win32";
  const isMac = process.platform === "darwin";
  const isArm = process.arch === "arm64";

  let userAgent;
  let metadataPlatform;

  if (isWin) {
    userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
    metadataPlatform = "WINDOWS";
  } else if (isMac) {
    userAgent = isArm
      ? "Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36"
      : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
    metadataPlatform = "MACOS";
  } else {
    // Linux: O Google Antigravity não possui binário oficial para Linux.
    // O cliente masqueradeia de forma consistente para evitar rejeição da API do Cloud Code.
    userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
    metadataPlatform = "WINDOWS";
  }

  return {
    "User-Agent": userAgent,
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: metadataPlatform, pluginType: "GEMINI" }),
  };
}

const PLATFORM_HEADERS = getHostPlatformHeaders();

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

export default {
  id: "antigravity",
  async setup(ctx) {
    console.log("[Antigravity] Plugin OpenCode v2 inicializado com SQP (Strict Quota Protocol 80%).");

    await ctx.session.hook("http.request", async (event) => {
      const url = event.request?.url || "";
      const isGoogleRequest = event.providerID === "google" || url.includes("googleapis.com");

      if (!isGoogleRequest) {
        return;
      }

      const settings = loadSettings();
      const thresholdPercent = settings.soft_quota_threshold_percent || DEFAULT_THRESHOLD_PERCENT;
      const minRemainingFraction = (100 - thresholdPercent) / 100; // 80% de uso -> 0.20 restante

      const storage = loadAccounts();
      const accounts = storage.accounts || [];

      if (accounts.length === 0) {
        return;
      }

      let selectedIndex = storage.activeIndex || 0;
      if (selectedIndex >= accounts.length) selectedIndex = 0;

      let selectedAccount = accounts[selectedIndex];
      let accessToken = null;

      try {
        accessToken = await getValidAccessToken(selectedAccount, selectedIndex);
      } catch (err) {
        console.warn(`[Antigravity] Falha na conta ${selectedIndex + 1}, alternando: ${err.message}`);
        if (accounts.length > 1) {
          selectedIndex = (selectedIndex + 1) % accounts.length;
          selectedAccount = accounts[selectedIndex];
          accessToken = await getValidAccessToken(selectedAccount, selectedIndex);
        } else {
          throw err;
        }
      }

      let quota = await fetchAccountQuota(selectedAccount, selectedIndex, accessToken);

      // Se a conta selecionada ultrapassou o limite de 80% (restante <= 20%)
      if (quota.remainingFraction <= minRemainingFraction) {
        console.warn(`[Antigravity] Conta ${selectedIndex + 1} (${selectedAccount.email || "ativa"}) atingiu ${Math.round((1 - quota.remainingFraction) * 100)}% de cota (limite seguro: ${thresholdPercent}%).`);

        if (accounts.length > 1) {
          const alternateIndex = (selectedIndex + 1) % accounts.length;
          const alternateAccount = accounts[alternateIndex];
          const alternateToken = await getValidAccessToken(alternateAccount, alternateIndex);
          const alternateQuota = await fetchAccountQuota(alternateAccount, alternateIndex, alternateToken);

          if (alternateQuota.remainingFraction > minRemainingFraction) {
            console.log(`[Antigravity] Rotacionando automaticamente para a Conta ${alternateIndex + 1} (${alternateAccount.email || "secundária"}) com ${Math.round(alternateQuota.remainingFraction * 100)}% de cota disponível.`);
            selectedIndex = alternateIndex;
            selectedAccount = alternateAccount;
            accessToken = alternateToken;
            quota = alternateQuota;
            storage.activeIndex = alternateIndex;
            saveAccounts(storage);
          } else {
            // AMBAS AS CONTAS ATINGIRAM 80%: Bloqueio local para evitar shadow ban e erro 429
            const reset1 = quota.resetTime ? Date.parse(quota.resetTime) : Date.now() + (5 * 3600 * 1000);
            const reset2 = alternateQuota.resetTime ? Date.parse(alternateQuota.resetTime) : Date.now() + (5 * 3600 * 1000);
            const earliestReset = Math.min(reset1, reset2);
            const waitMs = Math.max(0, earliestReset - Date.now());
            const countdown = formatCountdown(waitMs);

            const lockMessage = `[Antigravity Quota Protection] Ambas as contas atingiram o limite seguro de ${thresholdPercent}% de consumo (restante <= ${Math.round(minRemainingFraction * 100)}%). ` +
              `As requisições foram bloqueadas localmente para evitar erro 429 e proteger suas contas contra shadow ban. ` +
              `A cota mais próxima de uma das contas será restabelecida em aproximadamente ${countdown}.`;

            console.error("\n========================================================");
            console.error(lockMessage);
            console.error("========================================================\n");
            throw new Error(lockMessage);
          }
        } else {
          const reset = quota.resetTime ? Date.parse(quota.resetTime) : Date.now() + (5 * 3600 * 1000);
          const waitMs = Math.max(0, reset - Date.now());
          const countdown = formatCountdown(waitMs);

          const lockMessage = `[Antigravity Quota Protection] A sua conta atingiu o limite de segurança de ${thresholdPercent}% de cota. ` +
            `Requisição bloqueada preventivamente contra shadow ban. Liberação em aproximadamente ${countdown}.`;
          console.error(lockMessage);
          throw new Error(lockMessage);
        }
      }

      // Autenticação conforme tipo de conta
      if (selectedAccount.apiKey) {
        event.request.headers.set("x-goog-api-key", selectedAccount.apiKey);
      } else if (accessToken) {
        event.request.headers.set("Authorization", `Bearer ${accessToken}`);
      }

      // Headers oficiais alinhados com a plataforma do host
      event.request.headers.set("User-Agent", PLATFORM_HEADERS["User-Agent"]);
      event.request.headers.set("X-Goog-Api-Client", PLATFORM_HEADERS["X-Goog-Api-Client"]);
      event.request.headers.set("Client-Metadata", PLATFORM_HEADERS["Client-Metadata"]);

      selectedAccount.lastUsed = Date.now();
      saveAccounts(storage);
    });

    await ctx.session.hook("http.response", async (event) => {
      const status = event.response?.status;
      if (status === 429) {
        console.warn("[Antigravity] 429 Rate Limit detectado na resposta do Google! Marcando conta como temporariamente esgotada.");
        const storage = loadAccounts();
        const activeIdx = storage.activeIndex || 0;
        if (storage.accounts && storage.accounts[activeIdx]) {
          quotaCache.set(activeIdx, {
            timestamp: Date.now(),
            quota: { remainingFraction: 0, resetTime: new Date(Date.now() + (5 * 3600 * 1000)).toISOString() }
          });
          if (storage.accounts.length > 1) {
            storage.activeIndex = (activeIdx + 1) % storage.accounts.length;
            saveAccounts(storage);
            console.log(`[Antigravity] Rotacionado automaticamente para conta ${storage.activeIndex + 1} após 429.`);
          }
        }
      }
    });

    return () => {
      console.log("[Antigravity] Plugin finalizado/descarregado.");
    };
  }
};
