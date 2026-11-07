-- Run ONCE, after `pnpm db:migrate`, with the admin connection. Replace the password placeholder; never commit a real one.
-- The application connects as aaf_app: a plain login role that is not a superuser, not BYPASSRLS, owns nothing,
-- and has NO table privileges of its own. Per transaction it does SET LOCAL ROLE authenticated / anon / aaf_service.
--
--   psql "$DATABASE_ADMIN_URL" -v app_password="'<generated password>'" -f supabase/roles.example.sql

create role aaf_app login password :app_password nosuperuser nobypassrls nocreatedb nocreaterole;
grant anon, authenticated, aaf_service to aaf_app;

-- Verify (expect: rolsuper=f, rolbypassrls=f):
--   select rolname, rolsuper, rolbypassrls from pg_roles where rolname = 'aaf_app';
--
-- Supabase specifics:
--   * Use the TRANSACTION pooler connection string (port 6543) for DATABASE_URL, with user  aaf_app.<project-ref>
--   * Turn OFF the Data API (PostgREST) for the public schema, or at least do not expose it: the app uses direct Postgres,
--     and the REST layer would otherwise let any signed-in user write tables such as audit_log directly.
