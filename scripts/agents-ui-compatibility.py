"""Affected-only Linux host check. Requires installed Herdr/Bun/Python; never skips.

Run: python3 scripts/agents-ui-compatibility.py --evidence <absolute-owned-directory>
The package is packed with Bun and installed bytes are copied, never downloaded.
No production control command runs. On uncertain closure, retain the private root.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def run(evidence):
    source = Path(__file__).resolve().parent.parent
    evidence.mkdir(parents=True, exist_ok=False)
    root = Path(tempfile.mkdtemp(prefix="pitako-ui-"))
    evidence.joinpath("root.txt").write_text(str(root) + "\n")
    real_registry = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "herdr/plugins.json"
    before = real_registry.read_bytes() if real_registry.exists() else None
    evidence.joinpath("registry-before.json").write_text(json.dumps({
        "path": str(real_registry), "sha256": hashlib.sha256(before).hexdigest() if before is not None else None,
        "absent": before is None,
    }, indent=2))
    if before is not None:
        evidence.joinpath("registry-before.bytes").write_bytes(before)
    herdr, bun = shutil.which("herdr"), shutil.which("bun")
    assert herdr and bun, "Herdr and Bun are required; unavailable is not a skipped pass"
    env = {"PATH": os.pathsep.join(dict.fromkeys([str(Path(bun).parent), str(Path(herdr).parent), "/usr/bin", "/bin"])),
           "LANG": "C.UTF-8", "TERM": "xterm-256color", "SHELL": "/bin/sh", "PI_OFFLINE": "1"}
    for name, leaf in [("HOME", "home"), ("XDG_CONFIG_HOME", "config"), ("XDG_STATE_HOME", "state"),
                       ("XDG_CACHE_HOME", "cache"), ("XDG_RUNTIME_DIR", "runtime")]:
        folder = root / leaf
        folder.mkdir(mode=0o700)
        env[name] = str(folder)
    env["TMPDIR"] = env["XDG_RUNTIME_DIR"]
    config = root / "config/herdr"
    config.mkdir()
    socket = config / "sessions/t1/herdr.sock"
    env.update(HERDR_CONFIG_PATH=str(config / "config.toml"), HERDR_SOCKET_PATH=str(socket),
               HERDR_SESSION="t1", HERDR_BIN_PATH=herdr, PI_CODING_AGENT_DIR=str(root / "pi"))
    # All values are absolute/non-empty. No ambient secrets or production context survive.
    evidence.joinpath("environment.json").write_text(json.dumps(env, indent=2))
    (config / "config.toml").write_text(
        'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n'
        '[update]\nversion_check = false\nmanifest_check = false\n')
    commands = evidence.joinpath("commands.jsonl").open("w")
    server = client = master = None
    pump = None
    stop_pump = threading.Event()
    owned_pids = []
    settled = False
    observations = {}

    def compare_registry(phase):
        current = real_registry.read_bytes() if real_registry.exists() else None
        unchanged = current == before
        evidence.joinpath(f"registry-{phase}.json").write_text(json.dumps({
            "unchanged": unchanged,
            "sha256": hashlib.sha256(current).hexdigest() if current is not None else None,
            "absent": current is None,
        }, indent=2))
        assert unchanged, "Real-user plugin registry changed"
        return unchanged

    def command(argv, cwd=root, child_env=env, timeout=15, check=True):
        result = subprocess.run(list(map(str, argv)), cwd=cwd, env=child_env,
                                capture_output=True, timeout=timeout)
        commands.write(json.dumps({"argv": list(map(str, argv)), "cwd": str(cwd), "env": child_env,
                                   "exit": result.returncode, "stdout": result.stdout.decode(errors="replace"),
                                   "stderr": result.stderr.decode(errors="replace")}) + "\n")
        commands.flush()
        if check:
            assert result.returncode == 0, f"{argv}: exit {result.returncode}: {result.stderr.decode()}"
        return result

    def cli(*args, check=True):
        result = command([herdr, "--session", "t1", *args], check=check)
        if not check:
            return result
        # Herdr's mutating shell/key commands return an empty successful body.
        return json.loads(result.stdout)["result"] if result.stdout.strip() else {}

    def until(read, accepts, label):
        deadline = time.monotonic() + 20
        while True:
            value = read()
            if accepts(value):
                return value
            assert time.monotonic() < deadline, f"Timed out: {label}; last observation: {value}"
            stop_pump.wait(0.05)  # Poll observed state, never use sleep as proof.

    def snapshot():
        return cli("api", "snapshot")["snapshot"]

    def wait_text(pane, text):
        result = cli("pane", "wait-output", pane, "--match", text, "--source", "visible", "--timeout", "15000")
        evidence.joinpath(f"screen-{len(list(evidence.glob('screen-*'))):02}.json").write_text(json.dumps(result, indent=2))
        return result

    def key(pane, *keys):
        return cli("pane", "send-keys", pane, *keys)

    def receipt(name):
        file = root / "worker" / name
        return until(lambda: json.loads(file.read_text()) if file.exists() else None, lambda x: x is not None, name)

    try:
        assert command([herdr, "--version"]).stdout.strip() == b"herdr 0.9.3"
        assert command([bun, "--version"]).stdout.strip() == b"1.4.2"
        # These installed interfaces confirm the effective named socket/config paths before link.
        sessions = command([herdr, "session", "list", "--json"])
        evidence.joinpath("session-paths.json").write_bytes(sessions.stdout)
        help_text = command([herdr, "--help"]).stdout.decode()
        assert str(config / "config.toml") in help_text
        schema = json.loads(command([herdr, "api", "schema", "--json"]).stdout)
        assert schema["protocol"] == 22
        package_tree = root / "installed/node_modules"
        package_tree.parent.mkdir()
        # Copy existing declared peers/transitives to a conventional tree; no live symlinks/fallback.
        command(["cp", "-aL", "--reflink=auto", source / "node_modules", package_tree], timeout=120)
        env["PATH"] = str(package_tree / ".bin") + os.pathsep + env["PATH"]
        archive = root / "pitako.tgz"
        command([bun, "pm", "pack", "--ignore-scripts", "--quiet", "--filename", archive], cwd=source, timeout=120)
        pitako = package_tree / "pitako"
        pitako.mkdir()
        command(["tar", "-xzf", archive, "--strip-components=1", "-C", pitako], timeout=120)
        plugin = pitako / "extensions/herdr/agents-ui"
        peers = json.loads((pitako / "package.json").read_text())["peerDependencies"]
        probe = root / "installed/probe.ts"
        probe.write_text(f"""
import {{ realpathSync, readFileSync }} from "node:fs";
const entry = {json.dumps(str(plugin / 'pane.ts'))};
const peers = {json.dumps(list(peers))};
const ids = peers.map(name => {{
  const resolved = realpathSync(Bun.resolveSync(name, entry));
  const pkg = realpathSync(Bun.resolveSync(name + "/package.json", entry));
  return {{ name, resolved, pkg, version: JSON.parse(readFileSync(pkg, "utf8")).version }};
}});
const raw = process.stdin.isRaw;
const listeners = process.stdout.listenerCount("resize");
await import(entry);
await import({json.dumps(str(plugin / 'launcher.ts'))});
if (process.stdin.isRaw !== raw || process.stdout.listenerCount("resize") !== listeners)
  throw Error("Passive import initialized a terminal");
console.log(JSON.stringify(ids));
""")
        identities = json.loads(command([bun, probe], cwd=plugin).stdout)
        assert all(Path(row["resolved"]).is_relative_to(package_tree) for row in identities)
        assert all(row["version"] == "1.0.4" for row in identities if row["name"].startswith("@earendil"))
        for row in identities:
            row["entry_sha256"] = digest(Path(row["resolved"]))
            row["package_sha256"] = digest(Path(row["pkg"]))
            folder = Path(row["pkg"]).parent
            files = {str(file.relative_to(folder)): digest(file)
                     for file in sorted(folder.rglob("*")) if file.is_file()}
            row["tree_sha256"] = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
            row["tree_files"] = len(files)
        manual = command([bun, plugin / "pane.ts"], cwd=plugin, check=False)
        assert manual.returncode == 1 and not manual.stdout and b"owning Pi session" in manual.stderr
        assets = {str(file.relative_to(pitako)): digest(file)
                  for file in [*plugin.glob("*.ts"), plugin / "herdr-plugin.toml",
                               pitako / "extensions/agent/screen.ts", pitako / "extensions/agent/controller.ts",
                               pitako / "extensions/agent/pi.ts", pitako / "extensions/agent/live.ts",
                               pitako / "extensions/index.ts", pitako / "extensions/codex.ts"]}
        evidence.joinpath("identities.json").write_text(json.dumps({
            "baseline": command(["git", "rev-parse", "HEAD"], cwd=source).stdout.decode().strip(),
            "fixture_sha256": digest(Path(__file__).resolve()),
            "archive_sha256": digest(archive), "package_sha256": digest(pitako / "package.json"),
            "assets": assets, "peers": identities,
            "herdr_executable": herdr, "herdr_sha256": digest(Path(herdr)),
            "bun_executable": bun, "bun_sha256": digest(Path(bun)),
        }, indent=2))
        # Observation-only Bun preload from private plugin cwd. Published assets stay byte-identical.
        observer = root / "observer.ts"
        observer.write_text(f"""
import {{ appendFileSync, writeFileSync }} from "node:fs";
import {{ AgentScreen }} from {json.dumps(str(pitako / 'extensions/agent/screen.ts'))};
import {{ visibleWidth }} from {json.dumps(str(package_tree / '@earendil-works/pi-tui/dist/index.js'))};
if (Bun.main === {json.dumps(str(plugin / 'pane.ts'))}) {{
 const dir = {json.dumps(str(evidence))};
 const identity = {{
   pid: process.pid, cwd: process.cwd(), main: Bun.main,
   env: Object.fromEntries(Object.entries(process.env).filter(([k]) =>
     k.startsWith("HERDR_") || k.startsWith("XDG_") || k === "HOME" || k === "PITAKO_AGENTS_UI_DESCRIPTOR")),
   raw: !!process.stdin.isRaw, data: process.stdin.listenerCount("data"),
   resize: process.stdout.listenerCount("resize"), sigterm: process.listenerCount("SIGTERM"),
   sigint: process.listenerCount("SIGINT"),
 }};
 const log = dir + "/panel-" + process.pid;
 writeFileSync(log + "-start.json", JSON.stringify(identity, null, 2));
 const write = process.stdout.write.bind(process.stdout);
 process.stdout.write = (...args) => {{
   appendFileSync(log + ".ansi", args[0]);
   return write(...args);
 }};
 const emit = process.stdout.emit.bind(process.stdout);
 process.stdout.emit = (name, ...args) => {{
   if (name === "resize") appendFileSync(log + "-resize.jsonl",
     JSON.stringify({{ time: Date.now(), columns: process.stdout.columns, rows: process.stdout.rows }}) + "\\n");
   return emit(name, ...args);
 }};
 const render = AgentScreen.prototype.render;
 AgentScreen.prototype.render = function(width) {{
   const lines = render.call(this, width);
   appendFileSync(log + "-render.jsonl", JSON.stringify({{
     time: Date.now(), width, columns: process.stdout.columns, rows: process.stdout.rows,
     lines, widths: lines.map(visibleWidth),
   }}) + "\\n");
   return lines;
 }};
 process.on("beforeExit", () => writeFileSync(log + "-stop.json", JSON.stringify({{
   raw: !!process.stdin.isRaw, data: process.stdin.listenerCount("data"),
   resize: process.stdout.listenerCount("resize"), sigterm: process.listenerCount("SIGTERM"),
   sigint: process.listenerCount("SIGINT")
 }}, null, 2)));
}}
""")
        (plugin / "bunfig.toml").write_text("preload = [" + json.dumps(str(observer)) + "]\n")
        # Only test helpers are added to the private conventional peer tree.
        # Their relative production imports now bind exclusively to the unpacked assets.
        helpers = ["tests/fixtures/agent-pane-native.mjs", "tests/local-provider.ts"]
        for relative in helpers:
            target = pitako / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / relative, target)
        evidence.joinpath("helpers.json").write_text(json.dumps({
            relative: digest(pitako / relative) for relative in helpers}, indent=2))
        linked = cli("plugin", "link", str(plugin))
        compare_registry("after-link")
        assert linked["plugin"]["plugin_root"] == str(plugin)
        assert json.loads((config / "plugins.json").read_text())[0]["plugin_root"] == str(plugin)
        plugin_config = Path(command([herdr, "plugin", "config-dir", "pitako.agents-ui"]).stdout.decode().strip())
        assert plugin_config == config / "plugins/config/pitako.agents-ui"
        assert (root / "state/herdr/plugins/pitako.agents-ui").is_dir()
        observations["effective_paths"] = {"registry": str(config / "plugins.json"),
            "socket": str(socket), "plugin_config": str(plugin_config),
            "plugin_state": str(root / "state/herdr/plugins/pitako.agents-ui")}
        server_log = evidence.joinpath("server.log").open("wb")
        server = subprocess.Popen([herdr, "--session", "t1", "server"], cwd=root, env=env,
                                  stdout=server_log, stderr=subprocess.STDOUT)
        until(lambda: socket.exists(), bool, "private server socket")
        # Attach an owned client PTY so real pane dimensions track terminal resize.
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
        def attach_terminal():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        client = subprocess.Popen([herdr, "--session", "t1"], cwd=root, env=env,
                                  stdin=slave, stdout=slave, stderr=slave, preexec_fn=attach_terminal)
        os.close(slave)

        def drain():
            with evidence.joinpath("client.ansi").open("wb") as log:
                while not stop_pump.is_set():
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            chunk = os.read(master, 65536)
                        except OSError:
                            break
                        if not chunk:
                            break
                        log.write(chunk)
                        log.flush()

        pump = threading.Thread(target=drain)
        pump.start()
        initial = until(snapshot, lambda x: len(x["panes"]) > 0, "caller shell pane")
        caller = initial["panes"][0]["pane_id"]
        other = cli("tab", "create", "--cwd", str(root), "--focus")
        other_id = other["root_pane"]["pane_id"]
        assert snapshot()["focused_pane_id"] == other_id
        pi_start = shlex.join([bun, str(pitako / helpers[0]), str(root / "worker"), "--host"])
        cli("pane", "run", caller, pi_start)
        ready = receipt("pi-ready.json")
        assert ready["presence"]["paneId"] == caller
        assert ready["presence"]["socketPath"] == str(socket)
        observations["pi_presence"] = ready

        command_sequence = 0
        def pi_command(text):
            nonlocal command_sequence
            cli("pane", "send-text", caller, text)
            key(caller, "enter")
            if text != "/t4-exit":
                command_sequence += 1
                observed = receipt(f"command-{command_sequence}.json")
                assert observed["command"] == text
                assert not observed["notices"], observed
                evidence.joinpath(f"pi-command-{command_sequence}.json").write_text(json.dumps(observed, indent=2))

        pi_command("/pitako agents pane")
        panel = cli("pane", "neighbor", "--pane", caller, "--direction", "right")["neighbor"]["neighbor_pane_id"]
        live = snapshot()
        assert live["focused_pane_id"] == other_id
        panel_info = next(row for row in live["panes"] if row["pane_id"] == panel)
        assert panel_info["cwd"] == str(plugin) and panel_info["label"] == "Pitako agents"
        assert panel_info["tab_id"] == initial["panes"][0]["tab_id"] != other["tab"]["tab_id"]
        neighbor = cli("pane", "neighbor", "--pane", caller, "--direction", "right")
        observations["targeting"] = {"caller": caller, "other": other_id, "returned_panel": panel,
            "panel": panel_info, "neighbor": neighbor, "focused_after_open": live["focused_pane_id"]}
        assert neighbor["neighbor"]["neighbor_pane_id"] == panel
        wait_text(panel, "Agents · list")
        key(panel, "down", "enter")
        wait_text(panel, "Original packed pane WorkBrief")
        key(panel, "3")
        wait_text(panel, "pitako-local/fixture")
        key(panel, "q")
        wait_text(panel, "read-only")
        key(panel, "1")
        start_file = until(lambda: list(evidence.glob("panel-*-start.json")), bool, "packed entrypoint observation")[0]
        start = json.loads(start_file.read_text())
        owned_pids.append(start["pid"])
        descriptor = Path(start["env"]["PITAKO_AGENTS_UI_DESCRIPTOR"])
        assert start["cwd"] == str(plugin) and descriptor.is_absolute()
        assert descriptor.stat().st_mode & 0o777 == 0o600 and descriptor.parent.stat().st_mode & 0o777 == 0o700
        descriptor_value = json.loads(descriptor.read_text())
        assert descriptor_value["owner"]["coordinatorSessionId"] == ready["sessionId"]
        non_tui = command([bun, plugin / "pane.ts"], cwd=plugin,
            child_env={**env, "PITAKO_AGENTS_UI_DESCRIPTOR": str(descriptor)}, check=False)
        assert non_tui.returncode == 1 and not non_tui.stdout and b"requires a terminal" in non_tui.stderr
        assert start["env"]["HERDR_PANE_ID"] == panel != caller
        for name in ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"]:
            assert start["env"][name] == env[name]
        resize = evidence / f"panel-{start['pid']}-resize.jsonl"
        renders = evidence / f"panel-{start['pid']}-render.jsonl"
        def records(file):
            return [json.loads(line) for line in file.read_text().splitlines()] if file.exists() else []

        # Activate the caller's tab through the exact returned panel, never the ambient focus.
        pi_command("/pitako agents pane")
        assert snapshot()["focused_pane_id"] == panel
        assert len([row for row in snapshot()["panes"] if row["cwd"] == str(plugin)]) == 1
        key(panel, "esc")
        wait_text(panel, "Agents · list")
        initial_events = records(resize)
        initial_renders = records(renders)
        # Establish a live wide baseline; startup dimensions can precede Herdr's split resize.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 38, 150, 0, 0))
        wide_event = until(lambda: records(resize)[len(initial_events):],
            lambda rows: any(row["columns"] > 40 for row in rows), "wide host resize baseline")[-1]
        baseline = until(lambda: records(renders)[len(initial_renders):],
            lambda rows: any(row["width"] == wide_event["columns"] and row["rows"] == wide_event["rows"]
                             for row in rows), "wide host render baseline")[-1]
        wait_text(panel, baseline["lines"][-1])
        before_resize = records(resize)
        before_render = records(renders)
        before_layout = snapshot()
        evidence.joinpath("resize-before.json").write_text(json.dumps({
            "client": {"columns": 150, "rows": 38}, "render": baseline,
            "resize_events": before_resize, "snapshot": before_layout,
        }, indent=2))
        # The kernel signals the client's controlling PTY foreground process on size change.
        # No direct signal is sent to the client, pane or Pi process.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 28, 90, 0, 0))
        changed = until(lambda: records(resize)[len(before_resize):],
            lambda rows: any(row["columns"] != baseline["columns"] and row["rows"] != baseline["rows"]
                             for row in rows), "post-change packed pane resize dimensions")
        event = changed[-1]
        rendered = until(lambda: records(renders)[len(before_render):],
            lambda rows: any(row["width"] == event["columns"] and row["rows"] == event["rows"]
                             for row in rows), "render at changed terminal width")
        after_render = rendered[-1]
        assert after_render["width"] < baseline["width"]
        assert all(width <= after_render["width"] for width in after_render["widths"])
        assert after_render["lines"][-1] != baseline["lines"][-1], "Narrow list footer did not adapt"
        after_layout = snapshot()
        viewport = next(row["scroll"]["viewport_rows"] for row in after_layout["panes"] if row["pane_id"] == panel)
        assert event["rows"] == viewport
        evidence.joinpath("resize-after.json").write_text(json.dumps({
            "client": {"columns": 90, "rows": 28}, "resize_events": changed,
            "render": after_render, "snapshot": after_layout,
        }, indent=2))
        # Herdr's visible-text API trims terminal padding, including trailing footer spaces.
        narrow = wait_text(panel, after_render["lines"][-1].replace("\x1b[0m", "").rstrip())
        assert baseline["lines"][-1] not in narrow["read"]["text"], "Visible footer did not narrow"
        evidence.joinpath("resize-visible.json").write_text(json.dumps(narrow, indent=2))
        observations["resize"] = {"before": baseline, "event": event, "after": after_render}
        wait_text(panel, "Agents · list")
        key(panel, "enter")
        wait_text(panel, "Original packed pane WorkBrief")
        key(panel, "esc")
        wait_text(panel, "Agents · list")
        key(panel, "esc")
        stop = evidence / f"panel-{start['pid']}-stop.json"
        ended = until(lambda: json.loads(stop.read_text()) if stop.exists() else None, bool, "terminal restoration")
        for field in ["raw", "data", "resize", "sigterm", "sigint"]:
            assert ended[field] == start[field], (field, start, ended)
        ansi = evidence.joinpath(f"panel-{start['pid']}.ansi").read_bytes()
        assert b"\x1b[?1049h" in ansi and b"\x1b[?1049l" in ansi
        assert b"\x1b[?2004h" in ansi and b"\x1b[?2004l" in ansi and b"\x1b[?25h" in ansi
        assert b"\x1b[>7u" in ansi and b"\x1b[<u" in ansi
        for mode in [7, 1000, 1002, 1003, 1004, 1006]:
            assert f"\x1b[?{mode}l".encode() in ansi and f"\x1b[?{mode}h".encode() in ansi
        until(snapshot, lambda x: all(row["pane_id"] != panel for row in x["panes"]), "normal pane exit")
        until(lambda: Path(f"/proc/{start['pid']}").exists(), lambda x: not x, "first pane process settlement")
        # Capture the real response for an already gracefully exited exact owned pane.
        command([herdr, "plugin", "pane", "close", panel], check=False)
        # A fresh returned panel is the sole target of actual public focus/close calls from Pi.
        pi_command("/pitako agents pane close")
        assert not descriptor.exists()
        pi_command("/pitako agents pane")
        second = cli("pane", "neighbor", "--pane", caller, "--direction", "right")["neighbor"]["neighbor_pane_id"]
        wait_text(second, "Agents · list")
        pi_command("/pitako agents pane")
        assert snapshot()["focused_pane_id"] == second
        pi_command("/pitako agents pane close")
        after_close = snapshot()
        assert all(row["pane_id"] != second for row in after_close["panes"])
        assert {caller, other_id}.issubset({row["pane_id"] for row in after_close["panes"]})
        observations["focus_close"] = {"panel": second, "snapshot_after_close": after_close}
        pi_command("/t4-stop")
        assert receipt("worker-settled.json")["attempts"] == 1
        pi_command("/t4-exit")
        assert receipt("closure.json")["workerSettled"]
        evidence.joinpath("native-host.json").write_bytes((root / "worker/host-observed.json").read_bytes())
        evidence.joinpath("worker-closure.json").write_bytes((root / "worker/closure.json").read_bytes())
        for file in evidence.glob("panel-*-start.json"):
            pid = json.loads(file.read_text())["pid"]
            if pid not in owned_pids:
                owned_pids.append(pid)
        for relative, sha in assets.items():
            assert digest(pitako / relative) == sha, "Published entrypoint assets changed"
        compare_registry("after-run")
        evidence.joinpath("observations.json").write_text(json.dumps(observations, indent=2))
    finally:
        # Stop only the explicitly owned server and join its process and PTY client before deletion.
        try:
            if server is not None and (root / "worker/pi-ready.json").exists() and not (root / "worker/closure.json").exists():
                try:
                    pi_command("/pitako agents pane close")
                    pi_command("/t4-stop")
                    assert receipt("worker-settled.json")["attempts"] == 1
                    pi_command("/t4-exit")
                    assert receipt("closure.json")["workerSettled"]
                except Exception as error:
                    evidence.joinpath("native-cleanup-error.txt").write_text(repr(error))
            if (root / "worker/closure.json").exists():
                evidence.joinpath("worker-closure.json").write_bytes((root / "worker/closure.json").read_bytes())
            if (root / "worker/command-error.json").exists():
                evidence.joinpath("command-error.json").write_bytes((root / "worker/command-error.json").read_bytes())
            if server is not None:
                # Own all actual descendants (Pi, shells and plugin), not just the direct server PID.
                descendants = {server.pid}
                while True:
                    found = set()
                    for proc in Path("/proc").glob("[0-9]*/stat"):
                        try:
                            fields = proc.read_text().rsplit(")", 1)[1].split()
                            if int(fields[1]) in descendants:
                                found.add(int(proc.parent.name))
                        except (FileNotFoundError, ProcessLookupError):
                            pass
                    if found.issubset(descendants):
                        break
                    descendants.update(found)
                owned_pids.extend(sorted(descendants - {server.pid} - set(owned_pids)))
                command([herdr, "--session", "t1", "server", "stop"], timeout=25)
                server.wait(timeout=15)
                server_log.close()
            if client is not None:
                client.wait(timeout=15)
            for pid in owned_pids:
                until(lambda: Path(f"/proc/{pid}").exists(), lambda x: not x, f"owned pane {pid} settlement")
            settled = True
        finally:
            stop_pump.set()
            if pump is not None:
                pump.join(timeout=5)
                settled = settled and not pump.is_alive()
            if master is not None and (pump is None or not pump.is_alive()):
                os.close(master)
            unchanged = compare_registry("after-disposal")
            evidence.joinpath("closure.json").write_text(json.dumps({
                "settled": settled, "real_registry_unchanged": unchanged,
                "server_exit": server.returncode if server else None,
                "client_exit": client.returncode if client else None,
                "native_settled": (root / "worker/closure.json").exists(),
                "owned_panel_pids": owned_pids, "root": str(root),
            }, indent=2))
            commands.close()
    assert settled, f"Unproven closure; retain diagnostic root {root}"
    shutil.rmtree(root)
    evidence.joinpath("result.txt").write_text("PASS: packed Pi/Herdr public hosts; owned resources settled and removed\n")
    print(f"PASS: {evidence}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    assert args.evidence.is_absolute(), "Evidence must be an absolute fresh owned path"
    run(args.evidence)
