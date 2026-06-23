import { SignJWT } from "jose";

export const TEST_SECRET = "test-jwt-secret-do-not-use-in-prod";

export function getNamedDo(binding: DurableObjectNamespace, name: string): DurableObjectStub {
  // prod uses getByName; tests use idFromName+get. Works in both environments.
  return binding.get(binding.idFromName(name));
}

export interface JwtClaims {
  sub: string;
  exp?: number; // unix seconds
  iat?: number;
  client_id?: string;
  principal_id?: string;
  owner_user_id?: string;
  effective_account_user_id?: string;
  managed_session?: boolean;
  scope?: string;
  [k: string]: unknown;
}

export async function makeJwt(claims: JwtClaims, secret: string = TEST_SECRET): Promise<string> {
  const { sub, exp, iat, ...rest } = claims;
  const now = Math.floor(Date.now() / 1000);
  let builder = new SignJWT(rest).setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(sub);
  builder = builder.setExpirationTime(exp ?? now + 3600);
  if (iat !== undefined) builder = builder.setIssuedAt(iat);
  return builder.sign(new TextEncoder().encode(secret));
}
