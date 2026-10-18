import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import crypto from "node:crypto";

// Public Google Cloud Code / Antigravity Desktop OAuth Client credentials issued by Google LLC.
// NOTE: This is NOT a personal API key, user token, or private secret. It is Google's official public
// client identifier used by VS Code / IDE tools to initiate the standard OAuth 2.0 PKCE consent screen.
const CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID || "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET || "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";
const REDIRECT_URI = "http://localhost:51121/oauth-callback";
const SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs"
];

const CONFIG_PATH = join(homedir(), ".config/opencode/antigravity-accounts.json");

function base64url(buf) {
  return buf.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePKCE() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function loadAccounts() {
  if (!existsSync(CONFIG_PATH)) {
    return { version: 4, accounts: [], activeIndex: 0 };
  }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return { version: 4, accounts: [], activeIndex: 0 };
  }
}

function saveAccounts(data) {
  writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), "utf-8");
}

function openBrowser(url) {
  const platform = process.platform;
  try {
    if (platform === "win32") {
      exec(`powershell -NoProfile -Command "Start-Process '${url.replace(/'/g, "''")}'"`);
    } else if (platform === "darwin") {
      exec(`open "${url}"`);
    } else {
      exec(`xdg-open "${url}"`);
    }
  } catch {}
}

async function loginFlow() {
  console.log("\n========================================================");
  console.log("  Google Antigravity OAuth - OpenCode Multi-Account");
  console.log("========================================================\n");

  const pkce = generatePKCE();
  const state = base64url(Buffer.from(JSON.stringify({ verifier: pkce.verifier })));

  // Tenta as portas candidatas em ordem (evitando ranges bloqueados por Hyper-V/WSL no Windows)
  const candidatePorts = [51121, 45121, 35121, 18082, 0];
  let server;
  let activePort;

  let resolveCode, rejectCode;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const requestHandler = (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://localhost:${activePort}`);
      if (reqUrl.pathname === "/oauth-callback") {
        const code = reqUrl.searchParams.get("code");
        const error = reqUrl.searchParams.get("error");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<h2>Erro na autenticação: ${error}</h2>`);
          rejectCode(new Error(error));
          server.close();
          return;
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding: 40px; background: #0f172a; color: #f8fafc;">
                <h1 style="color: #4ade80;">Autenticação Concluída com Sucesso!</h1>
                <p>Você pode fechar esta aba e retornar ao OpenCode / Terminal.</p>
              </body>
            </html>
          `);
          resolveCode(code);
          setTimeout(() => server.close(), 1000);
          return;
        }
      }
      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      rejectCode(err);
    }
  };

  for (const port of candidatePorts) {
    try {
      const candidate = createServer(requestHandler);
      await new Promise((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen(port, "127.0.0.1", () => resolve());
      });
      server = candidate;
      activePort = server.address().port;
      break;
    } catch (err) {
      // Porta ocupada ou restrita pelo SO (ex: WinNAT/Hyper-V EACCES), tenta a próxima porta candidata
    }
  }

  if (!server) {
    throw new Error("Não foi possível iniciar o servidor local de callback OAuth em nenhuma porta.");
  }

  const redirectUri = `http://localhost:${activePort}/oauth-callback`;
  console.log(`Servidor local de callback ativo em http://127.0.0.1:${activePort}/oauth-callback`);

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", SCOPES.join(" "));
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent");

  console.log("Abrindo navegador para autenticação...");
  openBrowser(authUrl.toString());
  console.log("\nCaso não abra automaticamente, copie e cole este link:");
  console.log(authUrl.toString() + "\n");

  const timeoutTimer = setTimeout(() => {
    server.close();
    rejectCode(new Error("Timeout aguardando callback OAuth (5 minutos)."));
  }, 300000);

  const code = await codePromise;
  clearTimeout(timeoutTimer);
  console.log("Código recebido! Trocando por tokens com o Google...");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Falha ao obter tokens: ${tokenRes.status} ${errText}`);
  }

  const tokenData = await tokenRes.json();
  const refreshToken = tokenData.refresh_token;

  if (!refreshToken) {
    throw new Error("O Google não retornou um refresh_token. Remova o acesso do app na sua Conta Google e tente novamente.");
  }

  // Obter e-mail
  let email = "conta-antigravity";
  try {
    const userRes = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (userRes.ok) {
      const u = await userRes.json();
      if (u.email) email = u.email;
    }
  } catch {}

  const storage = loadAccounts();
  const existingIdx = storage.accounts.findIndex(a => a.email === email || a.refreshToken === refreshToken);

  const accountObj = {
    email,
    refreshToken,
    projectId: "rising-fact-p41fc",
    addedAt: Date.now(),
    lastUsed: Date.now(),
    quota: {
      claude: { remainingFraction: 1.0, resetTime: null },
      gemini: { remainingFraction: 1.0, resetTime: null }
    }
  };

  if (existingIdx >= 0) {
    storage.accounts[existingIdx] = accountObj;
    console.log(`\n✓ Conta atualizada com sucesso: ${email}`);
  } else {
    storage.accounts.push(accountObj);
    console.log(`\n✓ Nova conta adicionada com sucesso: ${email} (Total de contas: ${storage.accounts.length})`);
  }

  saveAccounts(storage);
  console.log(`Contas salvas em: ${CONFIG_PATH}\n`);
}

function listAccounts() {
  const storage = loadAccounts();
  console.log("\n========================================================");
  console.log("  Contas Antigravity Configuradas no OpenCode");
  console.log("========================================================\n");

  if (!storage.accounts || storage.accounts.length === 0) {
    console.log("Nenhuma conta configurada. Execute 'node auth-cli.mjs login' para adicionar.");
    return;
  }

  storage.accounts.forEach((acc, i) => {
    const isCurrent = i === (storage.activeIndex || 0) ? " [ATIVA]" : "";
    console.log(`[${i + 1}] ${acc.email || "Sem e-mail"}${isCurrent}`);
    console.log(`    Projeto: ${acc.projectId || "padrão"}`);
    if (acc.quota) {
      const geminiPct = acc.quota.gemini?.remainingFraction !== undefined 
        ? `${Math.round(acc.quota.gemini.remainingFraction * 100)}% restante` 
        : "N/A";
      const claudePct = acc.quota.claude?.remainingFraction !== undefined 
        ? `${Math.round(acc.quota.claude.remainingFraction * 100)}% restante` 
        : "N/A";
      console.log(`    Cota Gemini: ${geminiPct} | Claude: ${claudePct}`);
    }
    console.log("");
  });
}

const cmd = process.argv[2] || "list";
if (cmd === "login" || cmd === "add") {
  loginFlow().catch(err => {
    console.error("Erro durante autenticação:", err.message);
    process.exit(1);
  });
} else {
  listAccounts();
}
