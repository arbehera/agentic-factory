import { jwtVerify, type JWTVerifyGetKey } from "jose";

/** Portal roles (FR-POR-003, SDD §16.2), carried as Keycloak realm roles. */
export const PORTAL_ROLES = ["viewer", "operator", "role-owner", "pack-owner", "lead", "platform-admin", "auditor"] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];

export interface Principal {
  id: string;
  email: string | null;
  roles: readonly PortalRole[];
}

export class UnauthenticatedError extends Error {
  override name = "UnauthenticatedError";
}
export class ForbiddenError extends Error {
  override name = "ForbiddenError";
}

export interface AuthConfig {
  issuer: string;
  audience: string;
  /** Keycloak JWKS (createRemoteJWKSet) in deployment; a local key set in tests. */
  keys: JWTVerifyGetKey;
}

/**
 * Verifies OIDC access tokens from Keycloak (OPEN-22: local Keycloak in Compose for dev) and maps
 * realm roles to portal roles. Anything that is not a valid, unexpired token for this audience
 * and issuer is unauthenticated.
 */
export class PortalAuth {
  constructor(private readonly config: AuthConfig) {}

  async authenticate(authorization: string | undefined): Promise<Principal> {
    if (!authorization?.startsWith("Bearer ")) throw new UnauthenticatedError("missing bearer token");
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(authorization.slice(7), this.config.keys, { issuer: this.config.issuer, audience: this.config.audience }));
    } catch {
      throw new UnauthenticatedError("invalid or expired token");
    }
    const realmRoles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    const roles = Array.isArray(realmRoles) ? realmRoles.filter((r): r is PortalRole => (PORTAL_ROLES as readonly unknown[]).includes(r)) : [];
    const id = typeof payload.preferred_username === "string" ? payload.preferred_username : typeof payload.sub === "string" ? payload.sub : "";
    if (!id) throw new UnauthenticatedError("token has no subject");
    return { id, email: typeof payload.email === "string" ? payload.email : null, roles };
  }

  /** Throws ForbiddenError unless the principal holds one of `anyOf`. */
  static require(p: Principal, anyOf: readonly PortalRole[]): void {
    if (!p.roles.some((r) => anyOf.includes(r))) throw new ForbiddenError(`requires one of: ${anyOf.join(", ")}`);
  }
}
