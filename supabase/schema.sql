-- =====================================================================
-- Wrealispec · Capa 3: usuarios y datos (Supabase)
-- Esquema v1 · 11 nov 2026
--
-- Cómo se usa: Supabase → SQL Editor → New query → pegar TODO este
-- archivo → Run. Se puede volver a correr sin romper nada (es idempotente
-- en funciones y políticas; las tablas solo se crean si no existen).
--
-- Roles: alumno, maestro y dirección. Nadie puede darse un rol a sí mismo:
-- el rol de maestro o dirección lo asigna el administrador (ver LEEME.md).
-- Un alumno entra a un grupo con el código que le da su maestro.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------

-- Perfil de cada cuenta (se crea solo al registrarse).
create table if not exists public.perfiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nombre      text not null default '' check (char_length(nombre) <= 80),
  nivel       text not null default 'A2' check (nivel in ('A1','A2','B1','B2','C1','C2')),
  -- El plan solo lo cambia el administrador o el sistema de cobros, nunca el usuario.
  plan        text not null default 'piloto' check (plan in ('piloto','autodidacta','ia','pro')),
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now()
);

-- Escuela o maestro independiente (un maestro independiente es su propia "escuela").
create table if not exists public.escuelas (
  id     uuid primary key default gen_random_uuid(),
  nombre text not null check (char_length(nombre) between 1 and 120),
  creado timestamptz not null default now()
);

-- Quién pertenece a qué escuela y con qué rol. Una persona puede tener varios roles.
create table if not exists public.membresias (
  escuela_id uuid not null references public.escuelas (id) on delete cascade,
  usuario_id uuid not null references public.perfiles (id) on delete cascade,
  rol        text not null check (rol in ('alumno','maestro','direccion')),
  creado     timestamptz not null default now(),
  primary key (escuela_id, usuario_id, rol)
);

-- Grupo de un maestro. El código es lo que el maestro comparte con sus alumnos.
create table if not exists public.grupos (
  id         uuid primary key default gen_random_uuid(),
  escuela_id uuid not null references public.escuelas (id) on delete cascade,
  maestro_id uuid not null references public.perfiles (id) on delete restrict,
  nombre     text not null check (char_length(nombre) between 1 and 80),
  codigo     text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
             check (codigo ~ '^[A-Z0-9]{6,12}$'),
  activo     boolean not null default true,
  creado     timestamptz not null default now()
);

-- Alumnos inscritos en cada grupo.
create table if not exists public.inscripciones (
  grupo_id  uuid not null references public.grupos (id) on delete cascade,
  alumno_id uuid not null references public.perfiles (id) on delete cascade,
  creado    timestamptz not null default now(),
  primary key (grupo_id, alumno_id)
);

-- Tema que el maestro asigna (pregunta detonadora + verbos, adjetivos o estructuras).
create table if not exists public.tareas (
  id         uuid primary key default gen_random_uuid(),
  grupo_id   uuid not null references public.grupos (id) on delete cascade,
  maestro_id uuid not null references public.perfiles (id) on delete restrict,
  tema       text not null check (char_length(tema) between 1 and 300),
  nivel      text check (nivel in ('A1','A2','B1','B2','C1','C2')),
  requisitos jsonb not null default '{}'::jsonb,   -- misma forma que S.assignment en la app
  para       date,                                 -- fecha de entrega (opcional)
  creado     timestamptz not null default now()
);

-- Cada historia del alumno. "datos" guarda el objeto completo de la app (S),
-- así la app y la base hablan el mismo idioma sin traducir campo por campo.
create table if not exists public.historias (
  id          uuid primary key default gen_random_uuid(),
  alumno_id   uuid not null default auth.uid() references public.perfiles (id) on delete cascade,
  cliente_id  text not null check (char_length(cliente_id) <= 40),  -- el id que ya usa la app (S.id)
  tarea_id    uuid references public.tareas (id) on delete set null,
  tema        text not null default '' check (char_length(tema) <= 300),
  nivel       text check (nivel in ('A1','A2','B1','B2','C1','C2')),
  paso        smallint not null default 0 check (paso between 0 and 10),
  actual      boolean not null default false,       -- la historia en la que está trabajando
  datos       jsonb not null default '{}'::jsonb
              check (octet_length(datos::text) <= 300000),  -- tope de 300 KB por historia (sin audios)
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  unique (alumno_id, cliente_id)
);

create unique index if not exists historias_una_actual on public.historias (alumno_id) where actual;
create index if not exists historias_alumno_fecha on public.historias (alumno_id, actualizado desc);
create index if not exists inscripciones_alumno on public.inscripciones (alumno_id);
create index if not exists grupos_maestro on public.grupos (maestro_id);
create index if not exists membresias_usuario on public.membresias (usuario_id);
create index if not exists tareas_grupo on public.tareas (grupo_id, creado desc);

-- ---------------------------------------------------------------------
-- 2. Funciones de apoyo para las reglas por fila
--    (security definer evita que las reglas se llamen entre sí en bucle)
-- ---------------------------------------------------------------------

create or replace function public.tiene_rol(p_escuela uuid, p_rol text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.membresias m
                 where m.escuela_id = p_escuela and m.usuario_id = auth.uid() and m.rol = p_rol);
$$;

-- ¿Soy maestro de este alumno? (está inscrito en alguno de mis grupos)
create or replace function public.es_maestro_de(p_alumno uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inscripciones i join public.grupos g on g.id = i.grupo_id
                 where i.alumno_id = p_alumno and g.maestro_id = auth.uid());
$$;

-- ¿Soy dirección de la escuela de este alumno?
create or replace function public.es_direccion_de(p_alumno uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inscripciones i
                   join public.grupos g on g.id = i.grupo_id
                   join public.membresias m on m.escuela_id = g.escuela_id
                 where i.alumno_id = p_alumno and m.usuario_id = auth.uid() and m.rol = 'direccion');
$$;

-- ¿Este maestro me da clase? (para que el alumno vea el nombre de su maestro)
create or replace function public.es_mi_maestro(p_maestro uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inscripciones i join public.grupos g on g.id = i.grupo_id
                 where i.alumno_id = auth.uid() and g.maestro_id = p_maestro);
$$;

create or replace function public.estoy_en_grupo(p_grupo uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.inscripciones i where i.grupo_id = p_grupo and i.alumno_id = auth.uid());
$$;

create or replace function public.es_mi_grupo(p_grupo uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.grupos g where g.id = p_grupo and g.maestro_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- 3. Acciones que el usuario pide a la base (RPC)
-- ---------------------------------------------------------------------

-- El alumno se une a un grupo con el código que le dio su maestro.
create or replace function public.unirse_a_grupo(p_codigo text)
returns table (grupo_id uuid, grupo text, maestro text)
language plpgsql security definer set search_path = '' as $$
declare g public.grupos%rowtype;
begin
  if auth.uid() is null then raise exception 'sin_sesion'; end if;
  select * into g from public.grupos
   where codigo = upper(trim(p_codigo)) and activo;
  if not found then raise exception 'codigo_invalido'; end if;
  insert into public.inscripciones (grupo_id, alumno_id) values (g.id, auth.uid()) on conflict do nothing;
  insert into public.membresias (escuela_id, usuario_id, rol) values (g.escuela_id, auth.uid(), 'alumno') on conflict do nothing;
  return query select g.id, g.nombre, p.nombre from public.perfiles p where p.id = g.maestro_id;
end $$;

-- ---------------------------------------------------------------------
-- 4. Automatismos
-- ---------------------------------------------------------------------

-- Crea el perfil al registrarse (toma el nombre que mande la app, si lo hay).
create or replace function public.crear_perfil()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.perfiles (id, nombre)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'nombre', ''), 80))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists al_registrarse on auth.users;
create trigger al_registrarse after insert on auth.users
  for each row execute function public.crear_perfil();

create or replace function public.marcar_actualizado()
returns trigger language plpgsql set search_path = '' as $$
begin new.actualizado := now(); return new; end $$;

drop trigger if exists perfiles_actualizado on public.perfiles;
create trigger perfiles_actualizado before update on public.perfiles
  for each row execute function public.marcar_actualizado();
drop trigger if exists historias_actualizado on public.historias;
create trigger historias_actualizado before update on public.historias
  for each row execute function public.marcar_actualizado();

-- ---------------------------------------------------------------------
-- 5. Permisos: los visitantes sin cuenta (anon) no tocan nada;
--    los usuarios con cuenta solo lo que permiten las reglas por fila.
-- ---------------------------------------------------------------------

alter table public.perfiles      enable row level security;
alter table public.escuelas      enable row level security;
alter table public.membresias    enable row level security;
alter table public.grupos        enable row level security;
alter table public.inscripciones enable row level security;
alter table public.tareas        enable row level security;
alter table public.historias     enable row level security;

revoke all on public.perfiles, public.escuelas, public.membresias, public.grupos,
              public.inscripciones, public.tareas, public.historias from anon, authenticated;

grant select on public.perfiles, public.escuelas, public.membresias, public.grupos,
                public.inscripciones, public.tareas, public.historias to authenticated;
grant update (nombre, nivel) on public.perfiles to authenticated;          -- el plan no
grant insert, update, delete on public.historias to authenticated;
grant insert, update, delete on public.tareas to authenticated;
grant insert, update (nombre, activo) on public.grupos to authenticated;   -- ni maestro ni escuela se cambian
grant delete on public.inscripciones to authenticated;                     -- salir o sacar del grupo; entrar es con código

revoke execute on all functions in schema public from anon, public;
grant execute on function public.unirse_a_grupo(text) to authenticated;
grant execute on function public.tiene_rol(uuid, text), public.es_maestro_de(uuid), public.es_direccion_de(uuid),
                          public.es_mi_maestro(uuid), public.estoy_en_grupo(uuid), public.es_mi_grupo(uuid)
  to authenticated;

-- ---------------------------------------------------------------------
-- 6. Reglas por fila
-- ---------------------------------------------------------------------

-- Perfiles
drop policy if exists perfiles_ver on public.perfiles;
create policy perfiles_ver on public.perfiles for select to authenticated
  using (id = (select auth.uid()) or public.es_maestro_de(id) or public.es_direccion_de(id) or public.es_mi_maestro(id));
drop policy if exists perfiles_editar on public.perfiles;
create policy perfiles_editar on public.perfiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Escuelas: las ven sus miembros
drop policy if exists escuelas_ver on public.escuelas;
create policy escuelas_ver on public.escuelas for select to authenticated
  using (exists (select 1 from public.membresias m where m.escuela_id = escuelas.id and m.usuario_id = (select auth.uid())));

-- Membresías: cada quien ve las suyas; dirección ve las de su escuela
drop policy if exists membresias_ver on public.membresias;
create policy membresias_ver on public.membresias for select to authenticated
  using (usuario_id = (select auth.uid()) or public.tiene_rol(escuela_id, 'direccion'));

-- Grupos
drop policy if exists grupos_ver on public.grupos;
create policy grupos_ver on public.grupos for select to authenticated
  using (maestro_id = (select auth.uid()) or public.estoy_en_grupo(id) or public.tiene_rol(escuela_id, 'direccion'));
drop policy if exists grupos_crear on public.grupos;
create policy grupos_crear on public.grupos for insert to authenticated
  with check (maestro_id = (select auth.uid()) and public.tiene_rol(escuela_id, 'maestro'));
drop policy if exists grupos_editar on public.grupos;
create policy grupos_editar on public.grupos for update to authenticated
  using (maestro_id = (select auth.uid())) with check (maestro_id = (select auth.uid()));

-- Inscripciones
drop policy if exists inscripciones_ver on public.inscripciones;
create policy inscripciones_ver on public.inscripciones for select to authenticated
  using (alumno_id = (select auth.uid()) or public.es_mi_grupo(grupo_id)
         or exists (select 1 from public.grupos g where g.id = grupo_id and public.tiene_rol(g.escuela_id, 'direccion')));
drop policy if exists inscripciones_quitar on public.inscripciones;
create policy inscripciones_quitar on public.inscripciones for delete to authenticated
  using (alumno_id = (select auth.uid()) or public.es_mi_grupo(grupo_id));

-- Tareas
drop policy if exists tareas_ver on public.tareas;
create policy tareas_ver on public.tareas for select to authenticated
  using (public.es_mi_grupo(grupo_id) or public.estoy_en_grupo(grupo_id)
         or exists (select 1 from public.grupos g where g.id = grupo_id and public.tiene_rol(g.escuela_id, 'direccion')));
drop policy if exists tareas_crear on public.tareas;
create policy tareas_crear on public.tareas for insert to authenticated
  with check (maestro_id = (select auth.uid()) and public.es_mi_grupo(grupo_id));
drop policy if exists tareas_editar on public.tareas;
create policy tareas_editar on public.tareas for update to authenticated
  using (maestro_id = (select auth.uid())) with check (maestro_id = (select auth.uid()) and public.es_mi_grupo(grupo_id));
drop policy if exists tareas_borrar on public.tareas;
create policy tareas_borrar on public.tareas for delete to authenticated
  using (maestro_id = (select auth.uid()));

-- Historias: el alumno es dueño; su maestro y la dirección solo leen
drop policy if exists historias_ver on public.historias;
create policy historias_ver on public.historias for select to authenticated
  using (alumno_id = (select auth.uid()) or public.es_maestro_de(alumno_id) or public.es_direccion_de(alumno_id));
drop policy if exists historias_crear on public.historias;
create policy historias_crear on public.historias for insert to authenticated
  with check (alumno_id = (select auth.uid())
              and (tarea_id is null or exists (select 1 from public.tareas t where t.id = tarea_id and public.estoy_en_grupo(t.grupo_id))));
drop policy if exists historias_editar on public.historias;
create policy historias_editar on public.historias for update to authenticated
  using (alumno_id = (select auth.uid()))
  with check (alumno_id = (select auth.uid())
              and (tarea_id is null or exists (select 1 from public.tareas t where t.id = tarea_id and public.estoy_en_grupo(t.grupo_id))));
drop policy if exists historias_borrar on public.historias;
create policy historias_borrar on public.historias for delete to authenticated
  using (alumno_id = (select auth.uid()));
