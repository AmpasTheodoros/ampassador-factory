import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthProvider, AuthUser, SignInResult } from "./types";

/**
 * Supabase Auth provider. `getUser()` calls the Auth server to validate the JWT (not just decode it).
 * Returns id and email only: `user_metadata` / `app_metadata` are deliberately never read, so a client-editable
 * claim cannot become a role or a workspace.
 *
 * Verified by unit tests against a fake client. NOT verified against a live Supabase project (none available yet).
 */
export function createSupabaseAuth(getClient: () => Promise<SupabaseClient> | SupabaseClient): AuthProvider {
  return {
    name: "supabase",
    async getUser(): Promise<AuthUser | null> {
      const c = await getClient();
      const { data, error } = await c.auth.getUser();
      if (error || !data.user?.id || !data.user.email) return null;
      return { id: data.user.id, email: data.user.email };
    },
    async signIn(email, password): Promise<SignInResult> {
      const c = await getClient();
      const { data, error } = await c.auth.signInWithPassword({ email, password });
      if (error) return { ok: false, reason: error.status && error.status >= 500 ? "error" : "invalid" };
      return data.session ? { ok: true } : { ok: false, reason: "invalid" };
    },
    async signOut() {
      const c = await getClient();
      await c.auth.signOut({ scope: "global" }); // revoke all refresh tokens for this user
    },
  };
}
