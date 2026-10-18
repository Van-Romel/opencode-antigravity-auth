import { AntigravityCLIOAuthPlugin, GoogleOAuthPlugin } from "./src/plugin";

export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
};

export default AntigravityCLIOAuthPlugin;

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth";
