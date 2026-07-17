"""Runs INSIDE CPython-WASI. Newline-JSON request/response loop over stdio."""
import json
import sys

sys.stdout.write(json.dumps({"id": 0, "ready": True}) + "\n")
sys.stdout.flush()

for line in sys.stdin:
    req = json.loads(line)
    op = req["op"]
    if op == "quit":
        break
    if op == "ping":
        resp = {"id": req["id"], "pong": True}
    elif op == "echo":
        resp = {"id": req["id"], "x": req["x"] * 2}
    else:
        resp = {"id": req["id"], "error": f"unknown op {op}"}
    sys.stdout.write(json.dumps(resp) + "\n")
    sys.stdout.flush()
