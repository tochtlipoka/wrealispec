# Wrealispec · Capa 3: usuarios y datos (Supabase)

La app (capa 1) sigue hablando con el Worker (capa 2) para la IA. Supabase (capa 3) guarda cuentas, roles, grupos, tareas e historias. El Worker sigue siendo la única puerta a la IA.

## Qué hay en esta carpeta

| Archivo | Qué es |
|---|---|
| `schema.sql` | Esquema completo: 7 tablas, reglas por fila (RLS) y la función para unirse a un grupo con código. Se puede correr varias veces sin romper nada. |
| `pruebas/imitar-supabase.sql` | Imita en un Postgres local lo que Supabase trae de fábrica (roles `anon` y `authenticated`, `auth.uid()`). |
| `pruebas/reglas.sql` | 25 pruebas de las reglas: quién ve y quién cambia qué. |
| `planes.sql` | Planes de venta (prueba de 7 días, ia, pro, piloto) y el Auth Hook `claim_plan` que mete el plan en la sesión. Se corre después de `schema.sql`; los pasos están arriba del archivo. |
| `pruebas/planes.sql` | 12 pruebas de los planes y del hook. |

## Las 7 tablas

| Tabla | Para qué |
|---|---|
| `perfiles` | Una fila por cuenta: nombre, nivel (A1–C2) y plan. Se crea sola al registrarse. |
| `escuelas` | Escuela o maestro independiente (un maestro independiente es su propia escuela). |
| `membresias` | Quién es alumno, maestro o dirección en cada escuela. |
| `grupos` | Grupos de cada maestro, con un código de 8 letras/números para invitar alumnos. |
| `inscripciones` | Qué alumnos están en qué grupo. |
| `tareas` | Tema asignado por el maestro (pregunta detonadora y requisitos) con fecha opcional. |
| `historias` | Cada historia del alumno; `datos` guarda el objeto completo de la app. |

## Quién ve qué

| | Alumno | Maestro | Dirección | Sin cuenta |
|---|---|---|---|---|
| Sus historias | Ve y cambia | — | — | Nada |
| Historias de sus alumnos | — | Solo ve | Ve las de su escuela | Nada |
| Tareas | Ve las de sus grupos | Crea y cambia en sus grupos | Ve las de su escuela | Nada |
| Plan del perfil | No lo puede cambiar | No | No | Nada |
| Rol de maestro o dirección | No se lo puede dar | No | No | Nada |

## Alta del proyecto (una sola vez, lo hace Héctor)

1. Entrar a supabase.com con la cuenta de GitHub `tochtlipoka` → **New project**.
   - Nombre: `wrealispec`.
   - Contraseña de la base: generarla y guardarla en tu gestor de contraseñas (no se comparte con nadie, tampoco con Claude).
   - Región: la de Estados Unidos más cercana a México (East US o West US).
   - Plan: Free.
2. **SQL Editor → New query** → pegar todo `schema.sql` → **Run**. Debe terminar con «Success. No rows returned».
3. **Authentication → URL Configuration**:
   - Site URL: `https://wrealispec.com/app/`
   - Redirect URLs: `https://wrealispec.com/app/` y `https://www.wrealispec.com/app/`
4. **Project Settings → API**: copiar y mandarle a Claude **solo** estos dos datos (son públicos, van dentro de la app):
   - Project URL (`https://xxxx.supabase.co`)
   - Publishable key / anon key
   
   **Nunca** compartir la `service_role` / secret key: esa salta todas las reglas.

## Proyecto actual

- Proyecto `wrealispec` en la organización `hpopoca` (plan Free), región East US (North Virginia).
- URL: `https://bbepraefoojognseuxzq.supabase.co`. La app usa la publishable key (pública a propósito).
- Inicio de sesión del piloto: correo y contraseña, con **Confirm email apagado** (el correo gratuito de Supabase solo envía a miembros de la organización). Para el lanzamiento: correo propio (p. ej. Resend con wrealispec.com) para confirmar cuentas y recuperar contraseñas, y «Entrar con Google».
- Si alguien olvida su contraseña durante el piloto: Authentication → Users → el usuario → cambiarla.

## Tareas de administrador (SQL Editor)

Crear la escuela del piloto (o la de un maestro independiente):

```sql
insert into public.escuelas (nombre) values ('Piloto Wrealispec') returning id;
```

Dar rol de maestro a alguien que ya se registró (cambiar el correo y el id de la escuela):

```sql
insert into public.membresias (escuela_id, usuario_id, rol)
select 'ID-DE-LA-ESCUELA', id, 'maestro' from auth.users where email = 'maestra@correo.com';
```

Lo mismo con `'direccion'` para una dirección.

Crear un grupo para un maestro (el código es el que les comparte a sus alumnos; 6 a 12 letras o números en mayúscula):

```sql
insert into public.grupos (escuela_id, maestro_id, nombre, codigo)
select 'ID-DE-LA-ESCUELA', id, 'Grupo A2 lunes', 'CARLA123' from auth.users where email = 'maestra@correo.com'
returning codigo;
```

El alumno lo usa en la app: botón de su nombre (arriba a la derecha) → «Unirme». Para cambiar el plan de un alumno:

```sql
update public.perfiles set plan = 'pro' where id = (select id from auth.users where email = 'alumno@correo.com');
```

## Probar las reglas en local

```bash
psql -f supabase/pruebas/imitar-supabase.sql
psql -f supabase/schema.sql
psql -f supabase/pruebas/reglas.sql   # cada línea debe decir PASA
```
