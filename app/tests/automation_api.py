"""Integração local: cargo build -p bluescreen; python tests/automation_api.py.

Usa dados temporários e CLIs simulados. Não chama serviços de IA nem usa tokens.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def run():
    with tempfile.TemporaryDirectory(prefix="bluescreen-automation-") as tmp:
        tmp = Path(tmp)
        node = shutil.which("node")
        assert node, "Node.js necessário para simular os agentes"
        for provider in ("codex", "claude"):
            (tmp / f"{provider}.json").write_text(json.dumps({"verdict": "approve", "reason": "Revisado"}))
            (tmp / f"{provider}.cmd").write_text(f'@"{node}" "{tmp / "agent.cjs"}" {provider} %*\n')
        (tmp / "agent.cjs").write_text("const fs=require('fs'),path=require('path');process.stdin.resume();process.stdin.on('end',()=>console.log(fs.readFileSync(path.join(__dirname,process.argv[2]+'.json'),'utf8')));\n")
        env = {**os.environ, "BLUESCREEN_AUTOMATION_FILE": str(tmp / "automation.json"), "BLUESCREEN_PORT": str(free_port()), "PATH": str(tmp) + os.pathsep + os.environ["PATH"]}
        base = "http://127.0.0.1:" + env["BLUESCREEN_PORT"]
        flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        log = open(tmp / "server.log", "w")
        proc = subprocess.Popen([str(APP / "target/debug/bluescreen.exe"), "--no-open", str(APP.parent)], cwd=APP, env=env, stdout=log, stderr=log, creationflags=flags)

        def api(route, body=None, expected=200):
            data = None if body is None else json.dumps(body).encode()
            req = urllib.request.Request(base + "/api/" + route, data, {"X-BlueScreen": "automation-test", "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=15) as response:
                    status, result = response.status, json.load(response)
            except urllib.error.HTTPError as e:
                status, result = e.code, json.load(e)
            assert status == expected, (route, status, result)
            return result

        def node(nid, kind, params=None):
            return {"id": nid, "type": kind, "params": params or {}, "position": [60, 100]}

        def edge(a, b, port="out"):
            return {"from": a, "from_port": port, "to": b, "to_port": "in"}

        def save(nodes, edges, name="Teste de integração", **kwargs):
            return api("automator/flows", {"name": name, "nodes": nodes, "edges": edges, **kwargs})

        def wait_run(fid, status="completed"):
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                records = [r for r in api("automator/runs") if r["flow_id"] == fid]
                if records and records[0]["status"] not in ("running", "queued"):
                    assert records[0]["status"] == status, records[0]
                    return records[0]
                time.sleep(.05)
            raise AssertionError("execução não terminou")

        try:
            for _ in range(100):
                try:
                    api("automator/catalog")
                    break
                except (OSError, urllib.error.URLError):
                    time.sleep(.1)
            else:
                raise AssertionError("servidor não iniciou")

            specs = api("automator/catalog")
            # 13 nós de sempre, 17 de arquivos, texto, Windows e gatilhos automáticos, 16 de texto e mídia, 22 de endpoint, segurança, auditoria, integrações, dados e saúde do PC, mais os dos plugins ligados
            assert len([s for s in specs if not s["type"].startswith("plugin.")]) == 81
            assert not any("ollama" in s["type"] or "llm.local" in s["type"] for s in specs)
            api("automator/run", expected=405)
            api("automator/flows", {"name": "Inválido", "nodes": []}, 400)
            api("automator/flows", {"name": "LLM local", "nodes": [node("x", "llm.local")]}, 400)
            api("automator/flows", {"name": "Porta inválida", "nodes": [node("a", "trigger.manual"), node("b", "util.output")], "edges": [edge("a", "b", "bad")]}, 400)
            api("automator/flows", {"name": "Ciclo", "nodes": [node("t", "trigger.manual"), node("a", "util.text"), node("b", "util.output")], "edges": [edge("a", "b"), edge("b", "a")]}, 400)

            flow = save([node("t", "trigger.manual", {"sample": "ok"}), node("if", "logic.if", {"value": "{{input}}", "equals": "ok"}), node("yes", "util.text", {"text": "aprovado"}), node("no", "util.text", {"text": "errado"}), node("out", "util.output")], [edge("t", "if"), edge("if", "yes", "true"), edge("if", "no", "false"), edge("yes", "out"), edge("no", "out")])
            api("automator/run", {"flow_id": flow["id"]})
            result = wait_run(flow["id"])
            records = {r["id"]: r for r in result["nodes"]}
            assert records["no"]["status"] == "skipped"
            assert records["out"]["output"] == {"out": "aprovado"}

            delay = save([node("t", "trigger.manual"), node("d", "util.delay", {"seconds": 30})], [edge("t", "d")])
            api("automator/run", {"flow_id": delay["id"]})
            api("automator/run", {"flow_id": delay["id"]}, 409)
            api("automator/flows", {"action": "delete", "id": delay["id"]}, 409)
            api("automator/run", {"action": "stop", "flow_id": delay["id"]})
            wait_run(delay["id"], "cancelled")
            api("automator/flows", {"action": "delete", "id": delay["id"]})

            command = save([node("t", "trigger.manual"), node("cmd", "windows.command", {"program": node_program(), "args": ["-e", "process.stdout.write('executado')"], "timeout": 10000})], [edge("t", "cmd")])
            api("automator/run", {"flow_id": command["id"]})
            assert wait_run(command["id"])["nodes"][-1]["output"]["out"] == "executado"

            # MCP HTTP com inicialização, cabeçalho de sessão e resposta SSE.
            calls = []

            class MCP(BaseHTTPRequestHandler):
                def do_POST(self):
                    b = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    calls.append(b["method"])
                    if b["method"] == "initialize":
                        self.send_response(200)
                        self.send_header("Mcp-Session-Id", "test-session")
                        payload = json.dumps({"jsonrpc": "2.0", "id": b["id"], "result": {"protocolVersion": "2025-03-26", "capabilities": {}, "serverInfo": {"name": "test", "version": "1"}}})
                    else:
                        assert self.headers["Mcp-Session-Id"] == "test-session"
                        if b["method"] == "notifications/initialized":
                            self.send_response(202)
                            payload = ""
                        else:
                            assert b["params"] == {"name": "echo", "arguments": {"text": "MCP funciona"}}
                            self.send_response(200)
                            self.send_header("Content-Type", "text/event-stream")
                            payload = 'data: ' + json.dumps({"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": "MCP funciona"}]}}) + '\n\n'
                    self.end_headers()
                    self.wfile.write(payload.encode())

                def log_message(self, *args):
                    pass

            mock = ThreadingHTTPServer(("127.0.0.1", 0), MCP)
            threading.Thread(target=mock.serve_forever, daemon=True).start()
            mcp_flow = save([node("t", "trigger.manual"), node("mcp", "mcp.call", {"url": f"http://127.0.0.1:{mock.server_port}/mcp", "tool": "echo", "arguments": {"text": "MCP funciona"}})], [edge("t", "mcp")])
            api("automator/run", {"flow_id": mcp_flow["id"]})
            assert wait_run(mcp_flow["id"])["nodes"][-1]["output"]["out"]["content"][0]["text"] == "MCP funciona"
            assert calls == ["initialize", "notifications/initialized", "tools/call"]
            mock.shutdown()

            # OpenRouter sem token falha antes de enviar o pedido externo.
            router = save([node("t", "trigger.manual"), node("or", "ai.openrouter", {"model": "test/model", "prompt": "teste", "secret": "qa_missing_secret"})], [edge("t", "or")])
            api("automator/run", {"flow_id": router["id"]})
            assert "cofre" in wait_run(router["id"], "failed")["error"].lower()

            review = api("agents/reviews", {"proposal": "Revisão de teste", "providers": ["codex", "claude"], "cwd": str(tmp)})
            assert review["approved"] and len(review["reviews"]) == 2
            (tmp / "claude.json").write_text(json.dumps({"verdict": "revise", "reason": "Corrija primeiro"}))
            assert not api("agents/reviews", {"proposal": "Teste de divergência", "cwd": str(tmp)})["approved"]
            (tmp / "codex.json").write_text("resposta inválida")
            assert not api("agents/reviews", {"proposal": "Teste inválido", "providers": ["codex"], "cwd": str(tmp)})["approved"]
            api("agents/reviews", {"proposal": "Teste", "providers": ["gemini"]}, 400)

            # Uma IA propõe JSON; o núcleo valida e não salva/ativa automaticamente.
            generated = {"name": "Gerado", "active": True, "nodes": [node("t", "trigger.manual"), node("out", "util.output")], "edges": [edge("t", "out")]}
            (tmp / "codex.json").write_text(json.dumps(generated))
            proposal = api("automator/generate", {"request": "Um fluxo de teste", "provider": "codex", "cwd": str(tmp)})
            assert not proposal["active"] and not proposal["id"]
            assert not any(f["name"] == "Gerado" for f in api("automator/flows"))
            api("automator/generate", {"request": "Teste", "provider": "ollama"}, 400)

            event = api("agenda/events", {"title": "Lembrete de teste", "at": int(time.time() * 1000) - 10000, "flow_id": flow["id"]})
            before = len([r for r in api("automator/runs") if r["flow_id"] == flow["id"]])
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                events = api("agenda/events")
                if next(e for e in events if e["id"] == event["id"])["notified"]:
                    break
                time.sleep(.1)
            else:
                raise AssertionError("lembrete não disparou")
            time.sleep(.2)
            assert len([r for r in api("automator/runs") if r["flow_id"] == flow["id"]]) == before + 1
            assert wait_run(flow["id"])["nodes"][-1]["output"] == {"out": "aprovado"}
            api("agenda/events", {"action": "delete", "id": event["id"]})
            assert not api("agenda/events")
            scheduled = save([node("t", "trigger.schedule", {"every_minutes": 1})], [], active=True)
            assert scheduled["next_run"] > int(time.time() * 1000)
            # Disparos automáticos aguardam vaga, em vez de sumirem sob carga.
            blockers = []
            for i in range(4):
                f = save([node("t", "trigger.manual"), node("d", "util.delay", {"seconds": 30})], [edge("t", "d")], name=f"Ocupado {i}")
                blockers.append(f)
                api("automator/run", {"flow_id": f["id"]})
            queued_event = api("agenda/events", {"title": "Fluxo na fila", "at": int(time.time() * 1000) - 1000, "flow_id": flow["id"]})
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if any(r["flow_id"] == flow["id"] and r["status"] == "queued" for r in api("automator/runs")):
                    break
                time.sleep(.1)
            else:
                raise AssertionError("execução automática não ficou na fila")
            api("automator/run", {"action": "stop", "flow_id": blockers[0]["id"]})
            wait_run(blockers[0]["id"], "cancelled")
            wait_run(flow["id"])
            for f in blockers[1:]:
                api("automator/run", {"action": "stop", "flow_id": f["id"]})
                wait_run(f["id"], "cancelled")
            # Simula interrupção do processo e confirma recuperação do histórico.
            api("automator/run", {"flow_id": blockers[0]["id"]})
            proc.terminate()
            proc.wait(timeout=10)
            proc = subprocess.Popen([str(APP / "target/debug/bluescreen.exe"), "--no-open", str(APP.parent)], cwd=APP, env=env, stdout=log, stderr=log, creationflags=flags)
            for _ in range(100):
                try:
                    records = api("automator/runs")
                    if any(r["flow_id"] == blockers[0]["id"] and r["status"] == "interrupted" for r in records):
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(.1)
            else:
                raise AssertionError("execução interrompida não foi recuperada")
            stored = json.loads((tmp / "automation.json").read_text(encoding="utf-8"))
            assert len(stored["flows"]) >= 5 and len(stored["reviews"]) == 3
            assert next(e for e in stored["events"] if e["id"] == queued_event["id"])["notified"]
            print("OK: grafo, portas, ciclos, ramos, comandos, cancelamento, MCP, cofre, revisão, geração, agenda, fila e recuperação")
        finally:
            proc.terminate()
            proc.wait(timeout=10)
            log.close()


def node_program():
    return shutil.which("node")


if __name__ == "__main__":
    run()
