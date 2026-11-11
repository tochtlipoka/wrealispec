import json, sys, threading, http.server, functools, time
from playwright.sync_api import sync_playwright
S = sys.argv[1]; ROOT = "/home/claude/wrealispec"
H = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass
H = functools.partial(Q, directory=ROOT)
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), H); threading.Thread(target=srv.serve_forever, daemon=True).start()
mock = open(f"{ROOT}/supabase/pruebas/sbmock.js").read()
def story(i, topic, step):
    return {"id": i, "example": False, "date": "2026-11-10", "level": "A2", "topic": topic, "transcription": "My hero", "corrected": "My hero is my mom.",
            "errors": [], "strengths_es": [], "feedback_es": "", "word_count": 5, "teacher_questions": [], "useful_phrases": [], "step": step}
seed = {"name": "Ana", "current": story("111", "Who is your hero?", 1), "history": [story("100", "My city", 0)]}
res = []; errs = []
def ok(name, cond): res.append(("PASA " if cond else "FALLA") + "  " + name)
with sync_playwright() as p:
    br = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    ctx = br.new_context()
    ctx.route("**/*", lambda r: r.fulfill(body=mock, content_type="application/javascript") if "supabase-js" in r.request.url
              else (r.continue_() if r.request.url.startswith("http://127.0.0.1") else r.abort()))
    pg = ctx.new_page(); pg.on("pageerror", lambda e: errs.append(str(e)))
    U = "http://127.0.0.1:8765/app/"
    pg.goto(U); pg.evaluate("s => localStorage.setItem('wrelispek.v2', s)", json.dumps(seed)); pg.reload(); pg.wait_for_timeout(500)
    ok("carga sin errores en modo invitado", not errs)
    ok("botón dice Entrar", pg.inner_text("#acctLbl") == "Entrar")
    db = lambda: pg.evaluate("JSON.parse(localStorage.getItem('__mockdb')||'null')")
    ok("sin cuenta no carga Supabase", db() is None and pg.evaluate("!window.supabase"))
    pg.click("#btnAcct"); pg.wait_for_timeout(300)
    ok("abre el modal de cuenta", pg.is_visible("#acctModal"))
    pg.click("#acTabUp"); ok("pestaña crear cuenta muestra nombre", pg.is_visible("#acName") and pg.input_value("#acName") == "Ana")
    pg.fill("#acEmail", "ana@x.com"); pg.fill("#acPass", "123"); pg.click("#acGo"); pg.wait_for_timeout(200)
    ok("valida contraseña corta", "8 caracteres" in pg.inner_text("#acSt"))
    pg.fill("#acPass", "secreta123"); pg.click("#acGo"); pg.wait_for_timeout(2500)
    d = db(); h = d["historias"]
    ok("crea cuenta y pasa a vista con sesión", pg.is_visible("#acIn") and "ana@x.com" in pg.inner_text("#acWho"))
    ok("importa las 2 historias del navegador", sorted(x["cliente_id"] for x in h) == ["100", "111"])
    ok("la actual es la 111", [x["cliente_id"] for x in h if x["actual"]] == ["111"])
    ok("botón muestra el nombre", pg.inner_text("#acctLbl") == "Ana")
    ok("estado: todo guardado", "Todo guardado" in pg.inner_text("#acSync"))
    # Unirse a grupo
    pg.fill("#acCode", "nope"); pg.click("#acJoin"); pg.wait_for_timeout(200); ok("rechaza código mal formado", "6 a 12" in pg.inner_text("#acJoinSt"))
    pg.fill("#acCode", "XXXX1111"); pg.click("#acJoin"); pg.wait_for_timeout(300); ok("código inexistente avisa", "no existe" in pg.inner_text("#acJoinSt"))
    pg.fill("#acCode", "carla123"); pg.click("#acJoin"); pg.wait_for_timeout(500)
    ok("se une al grupo", "Grupo A2" in pg.inner_text("#acJoinSt") and "Maestra Carla" in pg.inner_text("#acGroups"))
    pg.click("#acClose")
    # Editar algo y ver que se sincroniza
    pg.click("#rail button >> nth=0"); pg.wait_for_timeout(300); pg.fill("#topic", "Who is your hero? (editado)"); pg.dispatch_event("#topic", "change"); pg.dispatch_event("#topic", "input")
    pg.wait_for_timeout(2500)
    cur = [x for x in db()["historias"] if x["cliente_id"] == "111"][0]
    ok("los cambios suben solos (tema editado)", "editado" in cur["datos"]["topic"] or "editado" in cur["tema"])
    # Otro dispositivo: borro el cuaderno local, dejo la sesión
    pg.evaluate("localStorage.removeItem('wrelispek.v2')"); pg.reload(); pg.wait_for_timeout(2500)
    ok("otro dispositivo recupera la historia actual", "Who is your hero?" in pg.input_value("#topic"))
    ok("otro dispositivo recupera el historial", "My city" in pg.text_content("#hist"))
    ok("al recargar no aparece la bienvenida", not pg.is_visible("#welcome"))
    # Cerrar sesión
    pg.click("#btnAcct"); pg.wait_for_timeout(300); pg.click("#acOutBtn"); pg.wait_for_timeout(1500)
    ok("cerrar sesión limpia el navegador", pg.evaluate("localStorage.getItem('wrelispek.v2')") is None or "My city" not in pg.text_content("#hist"))
    ok("vuelve a modo invitado", pg.inner_text("#acctLbl") == "Entrar")
    # Entrar de nuevo con contraseña equivocada y luego bien
    ok("tras cerrar sesión aparece la bienvenida con «Ya tengo cuenta»", pg.is_visible("#welcome") and pg.is_visible("#wAcct"))
    pg.click("#wAcct"); pg.wait_for_timeout(300); pg.fill("#acEmail", "ana@x.com"); pg.fill("#acPass", "malamala1"); pg.click("#acGo"); pg.wait_for_timeout(300)
    ok("contraseña incorrecta avisa en español", "incorrectos" in pg.inner_text("#acSt"))
    pg.fill("#acPass", "secreta123"); pg.click("#acGo"); pg.wait_for_timeout(2500)
    ok("al volver a entrar trae sus historias", "My city" in pg.text_content("#hist") and len(db()["historias"]) == 2)
    pg.set_viewport_size({"width": 375, "height": 800}); pg.click("#acClose"); pg.wait_for_timeout(200)
    pg.screenshot(path=f"{S}/movil.png"); pg.click("#btnAcct"); pg.wait_for_timeout(200); pg.screenshot(path=f"{S}/movil_modal.png")
    ok("sin errores de JavaScript en todo el recorrido", not errs)
    br.close()
print("\n".join(res)); print("ERRORES:", errs[:5])
