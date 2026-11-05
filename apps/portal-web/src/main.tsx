import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PortalApi } from "./api.js";
import { App } from "./App.js";

/**
 * Sign-in through Keycloak (OIDC authorization code + PKCE). Realm and client are configured per
 * environment (OPEN-22: local Keycloak in Compose for dev, P0-WP6/WP11).
 */
const users = new UserManager({
  authority: import.meta.env.VITE_OIDC_AUTHORITY,
  client_id: import.meta.env.VITE_OIDC_CLIENT_ID,
  redirect_uri: window.location.origin + window.location.pathname,
  response_type: "code",
  scope: "openid profile email",
  userStore: new WebStorageStateStore({ store: window.sessionStorage }),
});

async function token(): Promise<string> {
  const user = await users.getUser();
  if (!user || user.expired) {
    await users.signinRedirect();
    throw new Error("redirecting to sign-in");
  }
  return user.access_token;
}

async function start(): Promise<void> {
  if (new URLSearchParams(window.location.search).has("code")) {
    await users.signinRedirectCallback();
    window.history.replaceState({}, "", window.location.pathname);
  }
  const api = new PortalApi(import.meta.env.VITE_PORTAL_API_URL ?? "", token);
  const root = document.getElementById("root");
  if (!root) throw new Error("missing #root");
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={new QueryClient()}>
        <App api={api} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
