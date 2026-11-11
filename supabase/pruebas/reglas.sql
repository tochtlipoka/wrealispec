-- Pruebas de las reglas por fila de Wrealispec. Correr después de imitar-supabase.sql y schema.sql en un Postgres VACÍO.
\set QUIET on
\pset tuples_only on
-- Datos: 2 alumnos, 2 maestros, 1 dirección, 1 externo
insert into auth.users (id, email, raw_user_meta_data) values
 ('00000000-0000-0000-0000-00000000000a','a@x','{"nombre":"Ana"}'),
 ('00000000-0000-0000-0000-00000000000b','b@x','{"nombre":"Beto"}'),
 ('00000000-0000-0000-0000-00000000000c','m@x','{"nombre":"Maestra Carla"}'),
 ('00000000-0000-0000-0000-00000000000d','m2@x','{"nombre":"Maestro Dan"}'),
 ('00000000-0000-0000-0000-00000000000e','d@x','{"nombre":"Directora Eva"}'),
 ('00000000-0000-0000-0000-00000000000f','x@x','{}');
insert into public.escuelas (id, nombre) values ('10000000-0000-0000-0000-000000000001','Escuela Piloto');
insert into public.membresias values
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000c','maestro'),
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000d','maestro'),
 ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000e','direccion');

create function pg_temp.como(u text) returns void language sql as $$ select set_config('request.jwt.claim.sub', u, false) $$;
create function pg_temp.ok(nombre text, cond boolean) returns void language plpgsql as $$
begin raise notice '% %', case when cond then 'PASA ' else 'FALLA' end, nombre; end $$;

set role authenticated;
-- Maestra Carla crea su grupo y una tarea
select pg_temp.como('00000000-0000-0000-0000-00000000000c');
insert into public.grupos (escuela_id, maestro_id, nombre, codigo) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000c','Grupo A2','CARLA123');
insert into public.tareas (grupo_id, maestro_id, tema) select id, maestro_id, 'Who is your hero?' from public.grupos where codigo='CARLA123';
-- Maestro Dan crea el suyo
select pg_temp.como('00000000-0000-0000-0000-00000000000d');
insert into public.grupos (escuela_id, maestro_id, nombre, codigo) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000d','Grupo B1','DAN45678');

-- Ana entra con código a Carla; Beto a Dan
select pg_temp.como('00000000-0000-0000-0000-00000000000a'); select 1 from public.unirse_a_grupo(' carla123 ');
select pg_temp.como('00000000-0000-0000-0000-00000000000b'); select 1 from public.unirse_a_grupo('DAN45678');

-- Historias
select pg_temp.como('00000000-0000-0000-0000-00000000000a');
insert into public.historias (cliente_id, tema, actual, datos, tarea_id) select '1731300000000','Who is your hero?', true, '{"corrected":"My hero is my mom."}', id from public.tareas;
select pg_temp.como('00000000-0000-0000-0000-00000000000b');
insert into public.historias (cliente_id, tema, actual, datos) values ('1731300000001','My city', true, '{}');

-- PRUEBAS
select pg_temp.como('00000000-0000-0000-0000-00000000000a');
select pg_temp.ok('alumna ve solo su historia', (select count(*) from public.historias) = 1);
select pg_temp.ok('alumna ve el nombre de su maestra', exists(select 1 from public.perfiles where nombre='Maestra Carla'));
select pg_temp.ok('alumna no ve a otro alumno', not exists(select 1 from public.perfiles where nombre='Beto'));
select pg_temp.ok('alumna ve la tarea de su grupo', (select count(*) from public.tareas) = 1);
do $$ begin update public.perfiles set plan='pro' where id = auth.uid(); perform pg_temp.ok('alumna NO puede cambiarse el plan', false);
exception when insufficient_privilege then perform pg_temp.ok('alumna NO puede cambiarse el plan', true); end $$;
update public.perfiles set nombre='Ana G.' where id = auth.uid();
select pg_temp.ok('alumna sí cambia su nombre', (select nombre from public.perfiles where id=auth.uid())='Ana G.');
do $$ begin insert into public.membresias values ('10000000-0000-0000-0000-000000000001', auth.uid(), 'maestro'); perform pg_temp.ok('alumna NO se hace maestra', false);
exception when insufficient_privilege then perform pg_temp.ok('alumna NO se hace maestra', true); end $$;
do $$ begin insert into public.historias (alumno_id, cliente_id) values ('00000000-0000-0000-0000-00000000000b','x'); perform pg_temp.ok('alumna NO escribe historias ajenas', false);
exception when insufficient_privilege then perform pg_temp.ok('alumna NO escribe historias ajenas', true); end $$;
update public.historias set datos='{"hack":1}' where cliente_id='1731300000001';
do $$ begin insert into public.historias (cliente_id, actual) values ('otra', true); perform pg_temp.ok('solo una historia actual', false);
exception when unique_violation then perform pg_temp.ok('solo una historia actual', true); end $$;
do $$ begin perform public.unirse_a_grupo('NOEXISTE'); perform pg_temp.ok('código inválido se rechaza', false);
exception when others then perform pg_temp.ok('código inválido se rechaza', sqlerrm='codigo_invalido'); end $$;

select pg_temp.como('00000000-0000-0000-0000-00000000000b');
select pg_temp.ok('alumna no pudo alterar historia de Beto', (select datos from public.historias) = '{}'::jsonb);
do $$ begin insert into public.historias (cliente_id, tarea_id) select 'y', id from public.tareas; perform pg_temp.ok('Beto no ve tareas de otro grupo', (select count(*) from public.tareas)=0);
end $$;

select pg_temp.como('00000000-0000-0000-0000-00000000000c');
select pg_temp.ok('maestra ve la historia de su alumna', (select count(*) from public.historias) = 1 and (select tema from public.historias)='Who is your hero?');
select pg_temp.ok('maestra ve a su alumna', exists(select 1 from public.perfiles where nombre='Ana G.'));
update public.historias set datos='{}';
select pg_temp.ok('maestra NO modifica historias', (select datos->>'corrected' from public.historias)='My hero is my mom.');
do $$ begin insert into public.grupos (escuela_id, maestro_id, nombre) values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000d','Robado'); perform pg_temp.ok('maestra NO crea grupos a nombre de otro', false);
exception when insufficient_privilege then perform pg_temp.ok('maestra NO crea grupos a nombre de otro', true); end $$;

select pg_temp.como('00000000-0000-0000-0000-00000000000d');
select pg_temp.ok('maestro Dan ve solo a Beto', (select count(*) from public.historias)=1 and (select tema from public.historias)='My city');

select pg_temp.como('00000000-0000-0000-0000-00000000000e');
select pg_temp.ok('dirección ve las 2 historias de su escuela', (select count(*) from public.historias)=2);
select pg_temp.ok('dirección ve los 2 grupos de su escuela', (select count(*) from public.grupos)=2);

select pg_temp.como('00000000-0000-0000-0000-00000000000f');
select pg_temp.ok('externo no ve nada', (select count(*) from public.historias)+(select count(*) from public.grupos)+(select count(*) from public.escuelas)=0);
select pg_temp.ok('externo tiene su perfil creado solo', (select count(*) from public.perfiles)=1);
do $$ begin insert into public.grupos (escuela_id, maestro_id, nombre) values ('10000000-0000-0000-0000-000000000001', auth.uid(),'Pirata'); perform pg_temp.ok('externo NO crea grupos', false);
exception when insufficient_privilege then perform pg_temp.ok('externo NO crea grupos', true); end $$;

reset role; set role anon;
do $$ begin perform count(*) from public.historias; perform pg_temp.ok('visitante sin cuenta bloqueado', false);
exception when insufficient_privilege then perform pg_temp.ok('visitante sin cuenta bloqueado', true); end $$;
do $$ begin perform public.unirse_a_grupo('CARLA123'); perform pg_temp.ok('visitante NO usa el código', false);
exception when insufficient_privilege then perform pg_temp.ok('visitante NO usa el código', true); end $$;
reset role;
select pg_temp.ok('actualizado se mueve solo', (select actualizado > creado from public.perfiles where nombre='Ana G.'));
