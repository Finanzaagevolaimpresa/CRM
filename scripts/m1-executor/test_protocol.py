"""Exercise the real executable over stdio, with no installed authority."""
import json
from pathlib import Path
import subprocess
import sys

exe = Path(sys.argv[1]).resolve(strict=True)
requests = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "synthetic-test", "version": "1"}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "fai_crm_m1_status", "arguments": {}}},
    {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "fai_crm_m1_observe", "arguments": {}}},
    {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "fai_crm_m1_observe", "arguments": {"command": "whoami"}}},
    {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "deploy", "arguments": {}}},
]
result = subprocess.run([str(exe)], input=("\n".join(json.dumps(r) for r in requests)+"\n").encode("utf-8"),
                        capture_output=True, timeout=15, check=True)
assert not result.stderr, "unexpected process diagnostics"
responses = [json.loads(line) for line in result.stdout.decode("utf-8-sig").splitlines()]
assert len(responses) == 6
by_id = {r["id"]: r for r in responses}
assert by_id[1]["result"]["protocolVersion"] == "2025-06-18"
assert {t["name"] for t in by_id[2]["result"]["tools"]} == {
    "fai_crm_m1_status", "fai_crm_m1_observe", "fai_crm_m1_reconcile"}
status = json.loads(by_id[3]["result"]["content"][0]["text"])
assert status["installed"] is False and status["productionMutationCapability"] is False
assert status["code"] == "REVIEWED_INSTALLATION_REQUIRED"
for i, code in ((4, "REVIEWED_INSTALLATION_REQUIRED"), (5, "UNEXPECTED_FIELDS"), (6, "TOOL_NOT_ALLOWED")):
    assert by_id[i]["result"]["isError"] is True
    assert json.loads(by_id[i]["result"]["content"][0]["text"])["code"] == code
print(json.dumps({"status": "STDIO_PROTOCOL_AND_INSTALL_GATE_PASS", "requests": len(requests),
                  "remoteConnectionAttempted": False, "installationPerformed": False}))
