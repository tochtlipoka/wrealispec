-- Imita lo mínimo de Supabase para probar schema.sql en un Postgres local. NO correr en Supabase.
create role anon nologin; create role authenticated nologin; create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated; grant usage on schema public to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
-- Supabase da todo por defecto a estos roles; lo imitamos para comprobar el revoke
alter default privileges in schema public grant all on tables to anon, authenticated;
