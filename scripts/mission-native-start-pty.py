"""Small owned public-Pi PTY driver: command and native dialog input only."""
import json
import hashlib
import os
import pty
import select
import subprocess
import sys
import time

node, script, loader, out = sys.argv[1:5]
script, loader, out = map(os.path.abspath, (script, loader, out))
master, slave = pty.openpty()
env = dict(os.environ, PI_OFFLINE="1", TERM="xterm-256color")
def launch(restart=False):
    return subprocess.Popen([node, "--import", loader, script, out] + (["restart"] if restart else []),
                            stdin=slave, stdout=slave, stderr=slave, env=env)

child = launch()
os.close(slave)
transcript = bytearray()
started = time.monotonic()
sent = False
accepted = False
status_sent = False
stage = "start"
commands = []
lifetimes = []
case = os.environ.get("PITAKO_NATIVE_CASE", "complete")
phase_transcript = bytearray()

def send(command):
    os.write(master, command.encode() + b"\r")
    commands.append(command)

def close_process():
    os.write(master, b"\x03\x03")
    closing = time.monotonic()
    while child.poll() is None and time.monotonic() - closing < 20:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                transcript.extend(os.read(master, 65536))
            except OSError:
                break
    forced = child.poll() is None
    if forced:
        child.kill()
    child.wait(timeout=10)
    lifetimes.append({"pid": child.pid, "returnCode": child.returncode, "forcedKill": forced})

try:
    while time.monotonic() - started < (120 if case in ("refusal", "prerequisite") else 600):
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            transcript.extend(data)
            phase_transcript.extend(data)
        if not sent and b"[Extensions]" in transcript and time.monotonic() - started > 6:
            send("/mission start durable-fixture")
            sent = True
        if not accepted and b"Start frozen mission" in transcript:
            time.sleep(0.2)
            os.write(master, b"\x1b" if case == "refusal" else b"\r")
            accepted = True
        if case in ("refusal", "prerequisite"):
            expected = b'"state":"dismissed"' if case == "refusal" else b'"status":"technical-unresolved"'
            if expected in transcript and not status_sent:
                send("/mission status")
                status_sent = True
                phase_transcript.clear()
            elif status_sent and (b"No cached mission observation" in phase_transcript or b"preparation / author correction" in phase_transcript):
                stage = "adverse-observed"
                break
            continue
        mission_file = os.path.join(out, "mission.json")
        if accepted and os.path.exists(mission_file):
            with open(mission_file) as f:
                mission = json.load(f)
            events = mission["events"]
            if stage == "start" and any(e["kind"] == "unit.accepted" for e in events):
                send("/mission pause durable-fixture")
                phase_transcript.clear()
                stage = "pause-dialog"
            elif stage == "pause-dialog" and b"Confirm mission pause" in phase_transcript:
                os.write(master, b"\r")
                stage = "pausing"
            elif stage == "pausing" and mission["state"] == "paused":
                with open(os.path.join(out, "paused.json"), "w") as f:
                    json.dump(mission, f, indent=2)
                send("/mission resume durable-fixture")
                phase_transcript.clear()
                stage = "resume-dialog"
            elif stage == "resume-dialog" and b"Confirm mission resume" in phase_transcript:
                os.write(master, b"\r")
                stage = "resuming"
            elif stage == "resuming" and any(e["kind"] == "mission.resumed" for e in events):
                close_process()
                time.sleep(0.5)
                with open(mission_file) as f:
                    closed = json.load(f)
                with open(os.path.join(out, "closed.json"), "w") as f:
                    json.dump(closed, f, indent=2)
                # A new OS process discovers the immutable admission and saved close policy.
                os.close(master)
                master, slave = pty.openpty()
                child = launch(True)
                os.close(slave)
                phase_transcript.clear()
                stage = "recovering"
            elif stage == "recovering" and mission["state"] == "completed":
                send("/mission status")
                status_sent = True
                time.sleep(2)
                stage = "completed"
                break
            elif any(e["kind"] == "unit.blocked" for e in events) or mission["state"] in ("blocked", "failed"):
                raise RuntimeError("Native mission blocked; inspect its retained production observations")
        if sent and b"no mission" in transcript:
            break
finally:
    close_process()
    os.close(master)
    with open(os.path.join(out, "terminal.txt"), "wb") as f:
        f.write(transcript)
    with open(os.path.join(out, "driver.json"), "w") as f:
        json.dump({"nativeCommandSent": sent, "nativeConsentKeySent": accepted,
                   "nativeStatusCommandSent": status_sent,
                   "case": case, "stage": stage, "commands": commands, "lifetimes": lifetimes,
                   "seconds": time.monotonic() - started, "returnCode": child.returncode}, f)
print(json.dumps({"nativeCommandSent": sent, "nativeConsentKeySent": accepted}))
if case in ("refusal", "prerequisite"):
    assert stage == "adverse-observed", "Missing responsive actionable native adverse state"
    assert not os.path.exists(os.path.join(out, "mission.json")), "Adverse case admitted work"
    assert all(not row["forcedKill"] and row["returnCode"] == 0 for row in lifetimes)
    raise SystemExit(0)
if not (sent and accepted and status_sent):
    raise SystemExit("Native fixture did not observe the required engine product effect; inspect retained mission and terminal.")
with open(os.path.join(out, "mission.json")) as f:
    mission = json.load(f)
with open(os.path.join(out, "fixture.json")) as f:
    fixture = json.load(f)
events = mission["events"]
with open(os.path.join(out, "tool-result.json")) as f:
    author = json.load(f)
assert author["toolName"] == "codemode" and not author["isError"]
assert [call["name"] for call in author["details"]["calls"]] == ["mission_prepare", "mission_prepare"]
assert all(call["status"] == "ok" for call in author["details"]["calls"])
created = events[0]["payload"]
activation = next(e["payload"] for e in events if e["kind"] == "mission.activated")
effect = next(e["payload"] for e in events if e["kind"] == "effect.receipt")
assert mission["definition"]["schemaVersion"] == 3
assert mission["definition"]["resourcePolicy"]["limits"] == {"roleLaunches": 8, "artifactBytes": 20000000000}
assert not os.path.exists(fixture["definitionFile"])
assert fixture["root"] != fixture["executionRoot"]
assert created["snapshot"]["sourceBinding"]["planSource"] == fixture["planFile"]
assert activation["operatorInputId"] == created["operatorInputId"]
assert json.loads(activation["operatorText"])["action"] == "admit-and-start-frozen-mission-v1"
assert any(e["kind"] == "mission.setup.receipt" and e["payload"]["status"] == "completed" for e in events)
assert effect["status"] == "completed" and effect["exitCode"] == 0
assert effect["paths"][0]["after"]["hash"] == hashlib.sha256(b"product\n").hexdigest()
assert all(row["resource"] in ("role-launches", "artifact-bytes") for row in mission["reservations"])
assert stage == "completed" and mission["state"] == "completed"
assert len(lifetimes) == 2 and all(not row["forcedKill"] and row["returnCode"] == 0 for row in lifetimes)
assert len([e for e in events if e["kind"] == "unit.accepted"]) == 1
assert len([e for e in events if e["kind"] == "effect.receipt" and e["payload"].get("paths")]) == 1
assert len([e for e in events if e["kind"] == "mission.setup.receipt" and e["payload"]["status"] == "completed"]) == 1
assert any(e["kind"] == "mission.paused" and e["payload"].get("operatorSource") == "native-confirmation" for e in events)
assert any(e["kind"] == "mission.resumed" and e["payload"].get("operatorSource") == "native-confirmation" for e in events)
assert any(e["kind"] == "mission.recovery.recorded" and e["payload"]["status"] == "resumed" for e in events)
assert any(e["kind"] == "mission.finalization.reviewed" for e in events)
assert any(e["kind"] == "mission.completed" for e in events)
assert any(e["kind"] == "resource.metered.settled" and e["payload"]["resource"] == "tokens"
           and e["payload"]["knownCharge"] > 1 for e in events)
with open(os.path.join(out, "proof.json"), "w") as f:
    json.dump({"missionId": mission["id"], "preparedHash": created["snapshot"]["preparedHash"],
               "definitionHash": created["snapshot"]["definitionHash"], "schema": 3,
               "sidecarAbsent": True, "crossWorktree": True, "singleAdmissionId": activation["operatorInputId"],
               "setupCompleted": True, "containedProductEffectId": effect["effectId"],
               "estimatesExceededWithZeroReservations": True, "terminalStateAtObservation": mission["state"]}, f, indent=2)
