import { randomBytes, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

// Authorization codes are one-time-use and short-lived by design (RFC 6749 §4.1.2).
const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
// Access tokens are short-lived; clients are expected to use the refresh token to get new ones.
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  edToken: string;
  edRegion: string;
  expiresAt: number;
}

interface IssuedCredential {
  clientId: string;
  edToken: string;
  edRegion: string;
}

interface AccessTokenRecord extends IssuedCredential {
  expiresAt: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderConsentPage(params: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  error?: string;
}): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect edstem-mcp</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 480px; margin: 64px auto; padding: 0 20px; color: #1a1a1a; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  p { color: #555; line-height: 1.5; font-size: 14px; }
  label { display: block; margin-top: 18px; font-size: 13px; font-weight: 600; }
  input { width: 100%; padding: 10px; margin-top: 6px; box-sizing: border-box; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; }
  button { margin-top: 24px; width: 100%; padding: 12px; background: #d97757; color: white; border: none; border-radius: 6px; font-size: 15px; cursor: pointer; }
  button:hover { background: #c1633f; }
  .error { background: #fdecea; color: #a3231b; padding: 10px 12px; border-radius: 6px; margin-top: 16px; font-size: 13px; }
  a { color: #d97757; }
</style>
</head>
<body>
  <h1>Connect &ldquo;${escapeHtml(params.clientName)}&rdquo; to your Ed account</h1>
  <p>Paste your personal Ed Discussion API token below. It is used only to make requests on your behalf through this connection and is never shown to &ldquo;${escapeHtml(params.clientName)}&rdquo;.</p>
  <p>Get a token at <a href="https://edstem.org/us/settings/api-tokens" target="_blank" rel="noopener noreferrer">edstem.org/settings/api-tokens</a>.</p>
  ${params.error ? `<div class="error">${escapeHtml(params.error)}</div>` : ""}
  <form method="POST" action="/consent">
    <input type="hidden" name="client_id" value="${escapeHtml(params.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(params.redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(params.state)}">
    <input type="hidden" name="code_challenge" value="${escapeHtml(params.codeChallenge)}">
    <input type="hidden" name="resource" value="${escapeHtml(params.resource)}">
    <input type="hidden" name="scope" value="${escapeHtml(params.scope)}">
    <label for="ed_api_token">Ed API token</label>
    <input type="password" id="ed_api_token" name="ed_api_token" autocomplete="off" required autofocus>
    <label for="ed_region">Ed region</label>
    <input type="text" id="ed_region" name="ed_region" value="us">
    <button type="submit">Connect</button>
  </form>
</body>
</html>`;
}

/**
 * An MCP-compliant OAuth 2.1 authorization server that fronts Ed Discussion's
 * personal API tokens. Ed has no OAuth app system of its own, so the
 * "authorization" step is a form (rendered by `authorize`, submitted to the
 * `/authorize/consent` route in index.ts) where the user pastes their own Ed
 * token once. From then on, standard OAuth codes/tokens are issued and every
 * MCP client only ever sees its own scoped access/refresh token pair.
 *
 * State is in-memory and per-process: a redeploy or restart invalidates all
 * issued codes and tokens, and every connected client has to re-authorize.
 */
export class EdOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private authCodes = new Map<string, PendingAuthorization>();
  private accessTokens = new Map<string, AccessTokenRecord>();
  private refreshTokens = new Map<string, IssuedCredential>();

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.clients.get(clientId),
      registerClient: (client) => {
        const fullClient: OAuthClientInformationFull = {
          ...client,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.clients.set(fullClient.client_id, fullClient);
        return fullClient;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.status(200).type("html").send(
      renderConsentPage({
        clientName: client.client_name ?? client.client_id,
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        state: params.state ?? "",
        codeChallenge: params.codeChallenge,
        resource: params.resource?.toString() ?? "",
        scope: (params.scopes ?? []).join(" "),
      })
    );
  }

  /** Called by the /authorize/consent route in index.ts once the pasted Ed token has been verified. */
  issueAuthorizationCode(entry: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    edToken: string;
    edRegion: string;
  }): string {
    const code = randomBytes(32).toString("hex");
    this.authCodes.set(code, { ...entry, expiresAt: Date.now() + AUTH_CODE_TTL_MS });
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    if (Date.now() > entry.expiresAt) {
      this.authCodes.delete(authorizationCode);
      throw new InvalidGrantError("Authorization code expired");
    }
    return entry.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(authorizationCode);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid authorization code");
    }
    this.authCodes.delete(authorizationCode);
    if (Date.now() > entry.expiresAt) {
      throw new InvalidGrantError("Authorization code expired");
    }
    if (redirectUri && redirectUri !== entry.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the original request");
    }
    return this.issueTokens(client.client_id, entry.edToken, entry.edRegion);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry || entry.clientId !== client.client_id) {
      throw new InvalidGrantError("Invalid refresh token");
    }
    return this.issueTokens(client.client_id, entry.edToken, entry.edRegion, refreshToken);
  }

  private issueTokens(clientId: string, edToken: string, edRegion: string, reuseRefreshToken?: string): OAuthTokens {
    const accessToken = randomBytes(32).toString("hex");
    const refreshToken = reuseRefreshToken ?? randomBytes(32).toString("hex");
    this.accessTokens.set(accessToken, {
      clientId,
      edToken,
      edRegion,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000,
    });
    this.refreshTokens.set(refreshToken, { clientId, edToken, edRegion });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.accessTokens.get(token);
    if (!entry) {
      throw new InvalidTokenError("Invalid access token");
    }
    if (Date.now() > entry.expiresAt) {
      this.accessTokens.delete(token);
      throw new InvalidTokenError("Access token expired");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: [],
      expiresAt: Math.floor(entry.expiresAt / 1000),
      extra: { edToken: entry.edToken, edRegion: entry.edRegion },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const accessEntry = this.accessTokens.get(request.token);
    if (accessEntry && accessEntry.clientId === client.client_id) {
      this.accessTokens.delete(request.token);
      return;
    }
    const refreshEntry = this.refreshTokens.get(request.token);
    if (refreshEntry && refreshEntry.clientId === client.client_id) {
      this.refreshTokens.delete(request.token);
    }
  }
}
