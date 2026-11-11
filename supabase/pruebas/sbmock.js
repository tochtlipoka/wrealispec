// Imitación mínima de supabase-js para probar la app sin red. Guarda la "base" en localStorage.
(function(){
  const DBK = "__mockdb", TOK = "sb-bbepraefoojognseuxzq-auth-token";
  const db = () => JSON.parse(localStorage.getItem(DBK) || '{"users":[],"perfiles":[],"historias":[],"inscripciones":[],"grupos":[{"id":"g1","nombre":"Grupo A2","codigo":"CARLA123","maestro_id":"m1"}],"maestros":{"m1":"Maestra Carla"}}');
  const put = (d) => localStorage.setItem(DBK, JSON.stringify(d));
  window.__calls = [];
  function createClient(){
    const subs = [];
    const sess = () => { const t = localStorage.getItem(TOK); return t ? JSON.parse(t) : null; };
    const fire = (ev) => subs.forEach(cb => cb(ev, sess()));
    const uid = () => (sess() || {}).user && sess().user.id;
    const auth = {
      onAuthStateChange(cb){ subs.push(cb); setTimeout(() => cb("INITIAL_SESSION", sess()), 10); return { data:{ subscription:{ unsubscribe(){} } } }; },
      async signUp({ email, password, options }){
        const d = db(); if (d.users.find(u => u.email === email)) return { data:{}, error:{ code:"user_already_exists", message:"User already registered" } };
        const u = { id: "u" + (d.users.length + 1), email, password, user_metadata: options.data || {} };
        d.users.push(u); d.perfiles.push({ id: u.id, nombre: (u.user_metadata.nombre || ""), nivel: "A2" }); put(d);
        const s = { user: { id:u.id, email, user_metadata:u.user_metadata } }; localStorage.setItem(TOK, JSON.stringify(s)); fire("SIGNED_IN");
        return { data:{ session:s, user:s.user }, error:null };
      },
      async signInWithPassword({ email, password }){
        const u = db().users.find(x => x.email === email && x.password === password);
        if (!u) return { data:{}, error:{ code:"invalid_credentials", message:"Invalid login credentials" } };
        localStorage.setItem(TOK, JSON.stringify({ user:{ id:u.id, email, user_metadata:u.user_metadata } })); fire("SIGNED_IN"); return { data:{}, error:null };
      },
      async signOut(){ localStorage.removeItem(TOK); fire("SIGNED_OUT"); return { error:null }; }
    };
    function from(table){
      const q = { op:"select", f:[], one:false, lim:null, ord:null, payload:null, opts:null };
      const b = {
        select(){ return b; }, eq(k,v){ q.f.push(r => r[k] === v); return b; }, neq(k,v){ q.f.push(r => r[k] !== v); return b; },
        order(k,o){ q.ord = [k, o && o.ascending === false ? -1 : 1]; return b; }, limit(n){ q.lim = n; return b; }, maybeSingle(){ q.one = true; return b; },
        update(p){ q.op = "update"; q.payload = p; return b; }, upsert(p,o){ q.op = "upsert"; q.payload = p; q.opts = o; return b; }, insert(p){ q.op = "insert"; q.payload = p; return b; },
        then(res, rej){ return Promise.resolve().then(run).then(res, rej); }
      };
      function run(){
        window.__calls.push(table + ":" + q.op);
        const d = db(), me = uid(); const now = new Date(Date.now() + window.__calls.length).toISOString();
        if (!me) return { data:null, error:{ message:"no session" } };
        if (table === "inscripciones"){
          const rows = d.inscripciones.filter(i => i.alumno_id === me).map(i => { const g = d.grupos.find(x => x.id === i.grupo_id); return { grupos:{ nombre:g.nombre, maestro:{ nombre:d.maestros[g.maestro_id] } } }; });
          return { data:rows, error:null };
        }
        let rows = d[table].filter(r => table === "perfiles" ? r.id === me : r.alumno_id === me); // RLS: solo lo propio
        if (q.op === "select"){
          rows = rows.filter(r => q.f.every(fn => fn(r)));
          if (q.ord) rows.sort((a,b) => (a[q.ord[0]] > b[q.ord[0]] ? 1 : -1) * q.ord[1]);
          if (q.lim) rows = rows.slice(0, q.lim);
          return { data: q.one ? (rows[0] || null) : JSON.parse(JSON.stringify(rows)), error:null };
        }
        if (q.op === "update"){ rows.filter(r => q.f.every(fn => fn(r))).forEach(r => Object.assign(r, q.payload, table === "historias" ? { actualizado: now } : {})); }
        if (q.op === "insert" || q.op === "upsert"){
          for (const p of [].concat(q.payload)){
            const ex = d.historias.find(r => r.alumno_id === me && r.cliente_id === p.cliente_id);
            if (ex && q.op === "insert") return { data:null, error:{ message:"duplicate key" } };
            if (ex) Object.assign(ex, JSON.parse(JSON.stringify(p)), { actualizado: now });
            else d.historias.push(Object.assign({ alumno_id: me, actualizado: now }, JSON.parse(JSON.stringify(p))));
          }
          if (d.historias.filter(r => r.alumno_id === me && r.actual).length > 1) return { data:null, error:{ message:"historias_una_actual" } };
        }
        put(d); return { data:null, error:null };
      }
      return b;
    }
    async function rpc(name, args){
      const d = db(), me = uid(); const g = d.grupos.find(x => x.codigo === args.p_codigo);
      if (!g) return { data:null, error:{ message:"codigo_invalido" } };
      if (!d.inscripciones.find(i => i.grupo_id === g.id && i.alumno_id === me)) d.inscripciones.push({ grupo_id:g.id, alumno_id:me });
      put(d); return { data:[{ grupo_id:g.id, grupo:g.nombre, maestro:d.maestros[g.maestro_id] }], error:null };
    }
    return { auth, from, rpc };
  }
  window.supabase = { createClient };
})();
