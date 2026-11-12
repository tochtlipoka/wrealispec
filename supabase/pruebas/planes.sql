-- Pruebas de planes.sql. Correr en un Postgres VACÍO después de imitar-supabase.sql, schema.sql y planes.sql.
\set QUIET on
\pset tuples_only on
create or replace function pg_temp.ok(nombre text, cond boolean) returns void language plpgsql as $$
begin raise notice '% %', case when cond then 'PASA ' else 'FALLA' end, nombre; end $$;

insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-0000000000a1','nueva@x','{"nombre":"Nueva"}'),
 ('00000000-0000-0000-0000-0000000000a2','paga@x','{"nombre":"Paga"}');

select pg_temp.ok('cuenta nueva empieza en prueba',
  (select plan from public.perfiles where id = '00000000-0000-0000-0000-0000000000a1') = 'prueba');
select pg_temp.ok('la prueba vence en 7 días',
  (select prueba_hasta between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
     from public.perfiles where id = '00000000-0000-0000-0000-0000000000a1'));

-- El hook agrega wplan y wtrial a la sesión
select pg_temp.ok('hook: prueba lleva wplan y wtrial',
  (select (r -> 'claims' ->> 'wplan') = 'prueba' and (r -> 'claims' ->> 'wtrial')::bigint > extract(epoch from now())
     from (select public.claim_plan('{"user_id":"00000000-0000-0000-0000-0000000000a1","claims":{"sub":"x","role":"authenticated"}}'::jsonb) r) t));
select pg_temp.ok('hook: conserva los datos que ya traía la sesión',
  (select (r -> 'claims' ->> 'role') = 'authenticated'
     from (select public.claim_plan('{"user_id":"00000000-0000-0000-0000-0000000000a1","claims":{"sub":"x","role":"authenticated"}}'::jsonb) r) t));

update public.perfiles set plan = 'ia' where id = '00000000-0000-0000-0000-0000000000a2';
select pg_temp.ok('hook: plan ia lleva wplan ia y sin wtrial',
  (select (r -> 'claims' ->> 'wplan') = 'ia' and not (r -> 'claims' ? 'wtrial')
     from (select public.claim_plan('{"user_id":"00000000-0000-0000-0000-0000000000a2","claims":{"wtrial":1}}'::jsonb) r) t));
select pg_temp.ok('hook: cuenta sin perfil queda en prueba',
  (select (r -> 'claims' ->> 'wplan') = 'prueba'
     from (select public.claim_plan('{"user_id":"00000000-0000-0000-0000-0000000000ff","claims":{}}'::jsonb) r) t));

-- Planes válidos
do $$ begin
  begin
    update public.perfiles set plan = 'autodidacta' where id = '00000000-0000-0000-0000-0000000000a2';
    perform pg_temp.ok('ya no existe el plan autodidacta', false);
  exception when check_violation then perform pg_temp.ok('ya no existe el plan autodidacta', true);
  end;
end $$;

-- Permisos: un alumno no puede usar el hook ni cambiar su plan o su prueba
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false);
do $$ begin
  begin
    perform public.claim_plan('{"user_id":"00000000-0000-0000-0000-0000000000a1"}'::jsonb);
    perform pg_temp.ok('un alumno no puede correr el hook', false);
  exception when insufficient_privilege then perform pg_temp.ok('un alumno no puede correr el hook', true);
  end;
  begin
    update public.perfiles set prueba_hasta = now() + interval '1 year' where id = '00000000-0000-0000-0000-0000000000a1';
    perform pg_temp.ok('un alumno no puede alargar su prueba', false);
  exception when insufficient_privilege then perform pg_temp.ok('un alumno no puede alargar su prueba', true);
  end;
  begin
    update public.perfiles set plan = 'pro' where id = '00000000-0000-0000-0000-0000000000a1';
    perform pg_temp.ok('un alumno no puede subirse de plan', false);
  exception when insufficient_privilege then perform pg_temp.ok('un alumno no puede subirse de plan', true);
  end;
end $$;
reset role;

-- El sistema de sesiones sí puede leer el plan
set role supabase_auth_admin;
select pg_temp.ok('supabase_auth_admin lee el plan con RLS activo',
  (select count(*) from public.perfiles where id in ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2')) = 2);
select pg_temp.ok('supabase_auth_admin corre el hook',
  (select (public.claim_plan('{"user_id":"00000000-0000-0000-0000-0000000000a2","claims":{}}'::jsonb) -> 'claims' ->> 'wplan') = 'ia'));
reset role;
