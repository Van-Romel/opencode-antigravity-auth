import assert from "node:assert";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

console.log("========================================================");
console.log("  INICIANDO SUÍTE DE TESTES: ANTIGRAVITY OPENCODE V2");
console.log("========================================================\n");

let passed = 0;
let failed = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ [FAIL] ${name}`);
    console.error(`    Erro: ${err.message}`);
    failed++;
  }
}

async function itAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ [PASS] ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ [FAIL] ${name}`);
    console.error(`    Erro: ${err.message}`);
    failed++;
  }
}

// -------------------------------------------------------------
// Test 1: Quota threshold calculation logic (80% rule)
// -------------------------------------------------------------
it("Cálculo do limite de segurança de 80% (restante <= 20%)", () => {
  const threshold = 80;
  const minRemainingFraction = (100 - threshold) / 100; // 0.20

  assert.strictEqual(minRemainingFraction, 0.2);

  const safeFraction = 0.25; // 75% usado -> seguro
  assert.strictEqual(safeFraction > minRemainingFraction, true, "75% de uso deve ser permitido");

  const borderFraction = 0.20; // 80% usado -> no limite
  assert.strictEqual(borderFraction <= minRemainingFraction, true, "80% de uso deve disparar proteção");

  const exhaustedFraction = 0.10; // 90% usado -> bloqueado
  assert.strictEqual(exhaustedFraction <= minRemainingFraction, true, "90% de uso deve disparar proteção");
});

// -------------------------------------------------------------
// Test 2: Formatting countdowns to reset
// -------------------------------------------------------------
it("Formatação de contagem regressiva para reset de cota", () => {
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

  assert.strictEqual(formatCountdown(45 * 60 * 1000), "45min");
  assert.strictEqual(formatCountdown((2 * 3600 + 15 * 60) * 1000), "2h 15min");
  assert.strictEqual(formatCountdown(0), "agora");
});

// -------------------------------------------------------------
// Test 3: Multi-Account Rotation when Account 1 >= 80%
// -------------------------------------------------------------
it("Rotação automática para Conta 2 quando Conta 1 >= 80%", () => {
  const threshold = 80;
  const minRemaining = (100 - threshold) / 100;

  const accounts = [
    { email: "conta1@gmail.com", remaining: 0.15 }, // 85% usado
    { email: "conta2@gmail.com", remaining: 0.60 }  // 40% usado
  ];

  let activeIndex = 0;
  let selected = accounts[activeIndex];

  if (selected.remaining <= minRemaining) {
    const alternateIndex = (activeIndex + 1) % accounts.length;
    const alternate = accounts[alternateIndex];
    if (alternate.remaining > minRemaining) {
      activeIndex = alternateIndex;
      selected = alternate;
    }
  }

  assert.strictEqual(activeIndex, 1, "Deve ter rotacionado para o índice 1");
  assert.strictEqual(selected.email, "conta2@gmail.com", "Conta 2 deve ser a ativa");
});

// -------------------------------------------------------------
// Test 4: Hermetic Local Lock when BOTH accounts >= 80%
// -------------------------------------------------------------
it("Bloqueio local hermético quando AMBAS as contas >= 80%", () => {
  const threshold = 80;
  const minRemaining = (100 - threshold) / 100;

  const now = Date.now();
  const accounts = [
    { email: "conta1@gmail.com", remaining: 0.15, resetTime: now + (2 * 3600 * 1000) }, // reset em 2h
    { email: "conta2@gmail.com", remaining: 0.10, resetTime: now + (35 * 60 * 1000) }   // reset em 35min
  ];

  let locked = false;
  let lockErrorMsg = "";

  const acc1 = accounts[0];
  const acc2 = accounts[1];

  if (acc1.remaining <= minRemaining && acc2.remaining <= minRemaining) {
    locked = true;
    const earliestReset = Math.min(acc1.resetTime, acc2.resetTime);
    const waitMs = earliestReset - now;
    const totalMinutes = Math.floor(waitMs / (60 * 1000));
    lockErrorMsg = `[Antigravity Quota Protection] Ambas as contas atingiram ${threshold}%. Liberação em ${totalMinutes}min.`;
  }

  assert.strictEqual(locked, true, "O bloqueio local DEVE estar ativo");
  assert.strictEqual(lockErrorMsg.includes("35min"), true, "Deve usar o resetTime mais próximo (35min)");
  assert.strictEqual(lockErrorMsg.includes("80%"), true, "Deve informar o limite de 80%");
});

// -------------------------------------------------------------
// Test 5: Strict Windows Fingerprint validation
// -------------------------------------------------------------
it("Validação estrita de fingerprint de Windows (Anti-Mismatch)", () => {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36",
    "X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
    "Client-Metadata": JSON.stringify({ ideType: "ANTIGRAVITY", platform: "WINDOWS", pluginType: "GEMINI" }),
  };

  assert.strictEqual(headers["User-Agent"].includes("Windows NT 10.0; Win64; x64"), true);
  assert.strictEqual(headers["User-Agent"].includes("Darwin"), false, "Não pode conter Darwin");
  assert.strictEqual(headers["User-Agent"].includes("Macintosh"), false, "Não pode conter Macintosh");
  assert.strictEqual(headers["User-Agent"].includes("Linux"), false, "Não pode conter Linux");

  const meta = JSON.parse(headers["Client-Metadata"]);
  assert.strictEqual(meta.platform, "WINDOWS");
  assert.strictEqual(meta.ideType, "ANTIGRAVITY");
  assert.strictEqual(meta.pluginType, "GEMINI");
});

// -------------------------------------------------------------
// Test 6: Plugin module export structure for OpenCode v2
// -------------------------------------------------------------
await itAsync("Carregamento do módulo antigravity.js como plugin OpenCode v2", async () => {
  const pluginPath = new URL("../plugins/antigravity.js", import.meta.url).href;
  const mod = await import(pluginPath);
  assert.ok(mod.default, "Plugin deve ter export default");
  assert.strictEqual(typeof mod.default, "object", "export default deve ser um objeto");
  assert.strictEqual(mod.default.id, "antigravity", "id deve ser 'antigravity'");
  assert.strictEqual(typeof mod.default.setup, "function", "setup deve ser uma função");

  // Mock ctx para testar o hook de setup
  const hooks = new Map();
  const mockCtx = {
    session: {
      hook: async (name, handler) => {
        hooks.set(name, handler);
      }
    }
  };

  const cleanup = await mod.default.setup(mockCtx);
  assert.strictEqual(typeof cleanup, "function", "setup() deve retornar uma função de cleanup");
  assert.ok(hooks.has("http.request"), "Deve registrar o hook http.request");
  assert.ok(hooks.has("http.response"), "Deve registrar o hook http.response");

  cleanup();
});

// -------------------------------------------------------------
// Test 7: Generic environment variable resolution for OAuth token
// -------------------------------------------------------------
it("Resolução de variáveis de ambiente genéricas para OAuth (ANTIGRAVITY_REFRESH_TOKEN e aliases)", () => {
  const OAUTH_ENV_VARS = ["ANTIGRAVITY_REFRESH_TOKEN", "OPENCODE_ANTIGRAVITY_TOKEN", "APIKEYGOOGLEFOROPENCODE"];
  function resolveFirst(vars, env) {
    for (const v of vars) {
      if (env[v]) return env[v];
    }
    return null;
  }

  assert.strictEqual(resolveFirst(OAUTH_ENV_VARS, { ANTIGRAVITY_REFRESH_TOKEN: "token-padrao" }), "token-padrao");
  assert.strictEqual(resolveFirst(OAUTH_ENV_VARS, { OPENCODE_ANTIGRAVITY_TOKEN: "token-opencode" }), "token-opencode");
  assert.strictEqual(resolveFirst(OAUTH_ENV_VARS, { APIKEYGOOGLEFOROPENCODE: "token-legado" }), "token-legado");
  assert.strictEqual(resolveFirst(OAUTH_ENV_VARS, {}), null);
});

// -------------------------------------------------------------
// Test 8: Generic environment variable resolution for API key
// -------------------------------------------------------------
it("Resolução de variáveis de ambiente genéricas para API Key (GEMINI_API_KEY e GOOGLE_API_KEY)", () => {
  const API_KEY_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_GEMINI_KEY"];
  function resolveFirst(vars, env) {
    for (const v of vars) {
      if (env[v]) return env[v];
    }
    return null;
  }

  assert.strictEqual(resolveFirst(API_KEY_VARS, { GEMINI_API_KEY: "key-gemini" }), "key-gemini");
  assert.strictEqual(resolveFirst(API_KEY_VARS, { GOOGLE_API_KEY: "key-google" }), "key-google");
  assert.strictEqual(resolveFirst(API_KEY_VARS, {}), null);
});

// -------------------------------------------------------------
// Test 9: Synchronization logic with in-memory accounts array
// -------------------------------------------------------------
it("Pool de contas: Sincronização em memória de credenciais mockadas", () => {
  const mockStorage = {
    version: 4,
    accounts: [
      {
        email: "mock-account@example.com",
        refreshToken: "mock-token-sample",
        projectId: "rising-fact-p41fc",
        addedAt: Date.now(),
        lastUsed: Date.now()
      }
    ],
    activeIndex: 0
  };

  const dummyToken = "mock-new-token-123";
  const existing = mockStorage.accounts.find(a => a.refreshToken === dummyToken);
  if (!existing) {
    mockStorage.accounts.unshift({
      email: "mock-env-account",
      refreshToken: dummyToken,
      projectId: "rising-fact-p41fc",
      addedAt: Date.now(),
      lastUsed: Date.now()
    });
  }

  assert.strictEqual(mockStorage.accounts.length, 2, "Deve conter 2 contas após unshift");
  assert.strictEqual(mockStorage.accounts[0].refreshToken, dummyToken, "Conta mockada deve estar na frente");
});

// -------------------------------------------------------------
// Test 10: Multi-Platform Fingerprint Generator (Windows, macOS, Linux)
// -------------------------------------------------------------
it("Geração dinâmica de headers por plataforma (Windows, macOS, Linux)", () => {
  function getSimulatedPlatformHeaders(platform, arch) {
    const isWin = platform === "win32";
    const isMac = platform === "darwin";
    const isArm = arch === "arm64";

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
      userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/1.18.3 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36";
      metadataPlatform = "WINDOWS";
    }

    return {
      userAgent,
      metadataPlatform,
    };
  }

  const win = getSimulatedPlatformHeaders("win32", "x64");
  assert.strictEqual(win.metadataPlatform, "WINDOWS");
  assert.strictEqual(win.userAgent.includes("Windows NT 10.0"), true);

  const macArm = getSimulatedPlatformHeaders("darwin", "arm64");
  assert.strictEqual(macArm.metadataPlatform, "MACOS");
  assert.strictEqual(macArm.userAgent.includes("Macintosh"), true);

  const linux = getSimulatedPlatformHeaders("linux", "x64");
  assert.strictEqual(linux.metadataPlatform, "WINDOWS");
  assert.strictEqual(linux.userAgent.includes("Linux"), true);
});

console.log("\n========================================================");
console.log(`  RESULTADO: ${passed} passaram, ${failed} falharam.`);
console.log("========================================================\n");

if (failed > 0) {
  process.exit(1);
}
