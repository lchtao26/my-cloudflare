#!/usr/bin/env python3
"""Own an isolated read-only reader instance and retain its proof artifacts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = Path(__file__).resolve().parents[4]


def run(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def token():
    if os.environ.get("NOTION_TOKEN"):
        return os.environ["NOTION_TOKEN"]
    path = REPO / ".dev.vars"
    if path.exists():
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() == "NOTION_TOKEN":
                return value.strip().strip('"\'')
    raise RuntimeError("NOTION_TOKEN is required in the environment or repository .dev.vars; no credentials are printed")


def stamp(pid):
    return run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True).stdout.strip()


def load(evidence):
    return json.loads((evidence / "run.json").read_text())


def digest(root, names):
    h = hashlib.sha256()
    for name in sorted(names):
        h.update(name.encode())
        h.update((root / name).read_bytes())
    return h.hexdigest()


def get(base, path):
    with urllib.request.urlopen(base + path, timeout=30) as response:
        return response.status, response.headers, response.read()


def doctor(evidence):
    m = load(evidence)
    if m.get("stopped"):
        raise RuntimeError("This run was cleaned up; launch a new evidence directory")
    if stamp(m["pid"]) != m["started"]:
        raise RuntimeError("Instance process identity changed")
    listeners = run(["lsof", "-t", "-nP", f"-iTCP:{m['port']}", "-sTCP:LISTEN"], capture_output=True).stdout.split()
    if not listeners or any(os.getpgid(int(pid)) != m["pid"] for pid in listeners):
        raise RuntimeError("Port is not exclusively owned by this run")
    workspace = Path(m["workspace"])
    if digest(workspace, m["source_files"]) != m["source_sha256"]:
        raise RuntimeError("Running source differs from launch snapshot")
    status, headers, body = get(m["base"], "/api/read")
    data = json.loads(body)
    if status != 200 or data.get("kind") != "articles" or not data.get("items"):
        raise RuntimeError("Reader is not usable: /api/read must return at least one real Notion article")
    _, _, session = get(m["base"], "/api/session")
    if json.loads(session).get("authenticated") is not False:
        raise RuntimeError("Baseline must remain signed out")
    first = data["items"][0]
    _, _, body = get(m["base"], "/api/r/" + first["code"])
    article = json.loads(body)
    if not article.get("body"):
        raise RuntimeError("First article has no usable body")
    result = {"healthy": True, "base": m["base"], "revision": m["revision"], "source_sha256": m["source_sha256"], "list_cache_control": headers.get("Cache-Control"), "list_items": len(data["items"]), "article_code": first["code"], "authenticated": False, "mode": "real Notion reads; no action or AI credentials"}
    (evidence / "doctor.json").write_text(json.dumps(result, indent=2) + "\n")
    return result


def cleanup(evidence):
    m = load(evidence)
    if not m.get("stopped") and m.get("pid"):
        try:
            matches = stamp(m["pid"]) == m["started"]
        except subprocess.CalledProcessError:
            matches = False
        if matches:
            def members():
                rows = run(["ps", "-axo", "pid=,pgid=,stat="], capture_output=True).stdout.splitlines()
                return [int(parts[0]) for row in rows if len(parts := row.split()) == 3 and parts[1] == str(m["pid"]) and not parts[2].startswith("Z")]

            # Some sandboxed descendants deny group probes/signals even while
            # their parent accepts SIGTERM. Observe group exit through ps.
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(m["pid"], sig)
                except (ProcessLookupError, PermissionError):
                    pass
                for _ in range(50):
                    if not members():
                        break
                    time.sleep(0.1)
                if not members():
                    break
            if members():
                raise RuntimeError("Owned process group still has live children; keep workspace and inspect run.json")
        else:
            # Never signal an unrelated process after PID reuse. Check group residue.
            groups = run(["ps", "-axo", "pgid="], capture_output=True).stdout.split()
            if str(m["pid"]) in groups:
                raise RuntimeError("Leader identity lost with group still alive; inspect run.json and clean only this run's children")
    root = Path(m["workspace"])
    if root.name.startswith("my-cloudflare-verify-") and root.parent == Path(tempfile.gettempdir()).resolve():
        shutil.rmtree(root, ignore_errors=True)
    else:
        raise RuntimeError("Refusing cleanup outside the owned temporary workspace")
    m["stopped"] = True
    (evidence / "run.json").write_text(json.dumps(m, indent=2) + "\n")
    return {"stopped": True, "evidence_retained": str(evidence), "workspace_removed": not root.exists()}


def launch(evidence, port):
    if evidence.exists() and any(evidence.iterdir()):
        raise RuntimeError("Use a new empty evidence directory for each launch")
    secret = token()
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind(("127.0.0.1", port))  # Refuse to reuse another instance.
    evidence.mkdir(parents=True, exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="my-cloudflare-verify-")).resolve()
    names = run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True).stdout.split("\0")
    names = [n for n in names if n and not n.startswith((".agents/", ".git/", ".env"))]
    for name in names:
        source = REPO / name
        if source.is_file():
            dest = workspace / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
    if not (REPO / "node_modules/.bin/vite").exists():
        shutil.rmtree(workspace)
        raise RuntimeError("Run npm ci in the repository first")
    (workspace / "node_modules").symlink_to(REPO / "node_modules", target_is_directory=True)
    vars_file = workspace / ".dev.vars"
    vars_file.write_text("NOTION_TOKEN=" + json.dumps(secret) + '\nSENTRY_DSN=""\n')
    vars_file.chmod(0o600)
    (workspace / "vite.verify.config.ts").write_text('import base from "./vite.config";\nimport { defineConfig, mergeConfig } from "vite";\nexport default defineConfig(async env => mergeConfig(await (typeof base === "function" ? base(env) : base), { cacheDir: ".verify-vite-cache" }));\n')
    m = {"workspace": str(workspace), "base": f"http://127.0.0.1:{port}", "port": port, "revision": run(["git", "rev-parse", "HEAD"], cwd=REPO, capture_output=True).stdout.strip(), "source_files": names, "source_sha256": digest(workspace, names)}
    (evidence / "run.json").write_text(json.dumps(m, indent=2) + "\n")
    env = dict(os.environ)
    # Do not inherit mutation, deployment, telemetry or AI credentials.
    for name in list(env):
        if name.startswith(("NOTION_", "FAVORITE_", "INSTAPAPER_", "AI302_", "SENTRY_", "VITE_SENTRY_", "CLOUDFLARE_", "WRANGLER_")):
            env.pop(name)
    try:
        with (evidence / "migrations.log").open("w") as output:
            run([str(REPO / "node_modules/.bin/wrangler"), "d1", "migrations", "apply", "HIGHLIGHTS_DB", "--local", "--config", "wrangler.jsonc"], cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        with (evidence / "server.log").open("w") as output:
            proc = subprocess.Popen(["npm", "run", "dev", "--", "--config", "vite.verify.config.ts", "--host", "127.0.0.1", "--port", str(port), "--strictPort"], cwd=workspace, env=env, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
        m.update(pid=proc.pid, started=stamp(proc.pid))
        (evidence / "run.json").write_text(json.dumps(m, indent=2) + "\n")
        for _ in range(60):
            if proc.poll() is not None:
                raise RuntimeError("Server exited; inspect server.log")
            try:
                return doctor(evidence)
            except Exception as error:
                (evidence / "startup-check.txt").write_text(str(error) + "\n")
                time.sleep(0.5)
        raise RuntimeError("Usable startup timed out; inspect server.log and migrations.log")
    except BaseException:
        cleanup(evidence)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["launch", "doctor", "cleanup"])
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8799)
    args = parser.parse_args()
    evidence = args.evidence.resolve()
    if evidence == REPO or REPO in evidence.parents:
        parser.error("Evidence must be outside the checkout")
    try:
        result = launch(evidence, args.port) if args.command == "launch" else doctor(evidence) if args.command == "doctor" else cleanup(evidence)
        print(json.dumps(result, indent=2))
    except Exception as error:
        print(f"verification failed: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
