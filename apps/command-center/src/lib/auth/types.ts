export interface AuthUser {
  id: string;
  email: string;
}

export type SignInResult = { ok: true } | { ok: false; reason: "invalid" | "error" };

/**
 * Identity only. Authorization (workspace, role) always comes from the `memberships` table,
 * never from anything the client or the token's user metadata can influence.
 */
export interface AuthProvider {
  readonly name: "supabase" | "local";
  /** Server-verified current user, or null. Must not trust cookies without verification. */
  getUser(): Promise<AuthUser | null>;
  signIn(email: string, password: string): Promise<SignInResult>;
  /** Revokes the session server-side, not just the cookie. */
  signOut(): Promise<void>;
}
