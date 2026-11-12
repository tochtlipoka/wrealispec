-- =====================================================================
-- Wrealispec · Planes de venta y prueba gratis de 7 días
-- v1 · 12 nov 2026 · se corre DESPUÉS de schema.sql
--
-- Cómo se usa (una sola vez, lo hace Héctor):
--   1. Supabase → SQL Editor → New query → pegar TODO este archivo → Run.
--      Se puede volver a correr sin romper nada.
--   2. Supabase → Authentication → Auth Hooks → Add hook →
--      «Customize Access Token (JWT) Claims» → Postgres → schema public →
--      función claim_plan → Create.
--
-- Qué hace:
--   · Los planes quedan en: prueba (7 días gratis), ia (20 USD), pro (99 USD)
--     y piloto (interno, gratis). Se quita «autodidacta».
--   · Cada cuenta NUEVA empieza en «prueba» y la prueba vence 7 días después.
--     Las cuentas que ya existían se quedan como estaban (piloto).
--   · Cada vez que Supabase entrega o renueva la sesión de un alumno, la función
--     claim_plan agrega su plan («wplan») y, si está en prueba, cuándo vence
--     («wtrial»). Como la sesión va sellada, el alumno no puede cambiarlos.
--     El Worker lee esos datos para saber qué fases abrir y qué límite aplicar.
--
-- Para cambiar el plan de alguien (por ejemplo, un alumno del piloto o uno que ya pagó):
--   Table Editor → perfiles → columna plan → piloto | ia | pro | prueba.
--   El cambio llega a la app en máximo 1 hora, o al instante si vuelve a entrar.
-- =====================================================================

-- 1. Columna con la fecha en que vence la prueba.
alter table public.perfiles add column if not exists prueba_hasta timestamptz;

-- 2. Planes válidos (antes: piloto, autodidacta, ia, pro).
update public.perfiles set plan = 'ia' where plan = 'autodidacta';
alter table public.perfiles drop constraint if exists perfiles_plan_check;
alter table public.perfiles add constraint perfiles_plan_check check (plan in ('prueba','ia','pro','piloto'));

-- 3. Las cuentas nuevas empiezan con 7 días de prueba.
alter table public.perfiles alter column plan set default 'prueba';
alter table public.perfiles alter column prueba_hasta set default (now() + interval '7 days');

-- 4. Dato del plan dentro de la sesión (Custom Access Token Hook).
create or replace function public.claim_plan(event jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  p text;
  hasta timestamptz;
  claims jsonb := coalesce(event -> 'claims', '{}'::jsonb);
begin
  select plan, prueba_hasta into p, hasta from public.perfiles where id = (event ->> 'user_id')::uuid;
  claims := jsonb_set(claims, '{wplan}', to_jsonb(coalesce(p, 'prueba')));
  if coalesce(p, 'prueba') = 'prueba' then
    claims := jsonb_set(claims, '{wtrial}', to_jsonb(floor(extract(epoch from coalesce(hasta, now() + interval '7 days')))::bigint));
  else
    claims := claims - 'wtrial';
  end if;
  return jsonb_set(event, '{claims}', claims);
end $$;

-- Solo el sistema de sesiones de Supabase puede usar la función; los alumnos no.
grant usage on schema public to supabase_auth_admin;
grant execute on function public.claim_plan(jsonb) to supabase_auth_admin;
revoke execute on function public.claim_plan(jsonb) from authenticated, anon, public;
grant select (id, plan, prueba_hasta) on public.perfiles to supabase_auth_admin;
drop policy if exists perfiles_hook on public.perfiles;
create policy perfiles_hook on public.perfiles for select to supabase_auth_admin using (true);
