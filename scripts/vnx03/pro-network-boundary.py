"""Read-only Pro build/runtime boundary. Never starts or repairs Docker resources.

Build observations do not establish endpoint ownership. Admission proves only
the sampled boundary; the authorized outer driver must monitor runtime/cleanup.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import time

CONTRACT = "build-boundary-v1"
ENDPOINTS = {"unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine",
             "npipe:////./pipe/dockerDesktopLinuxEngine"}
STABLE = ("Name", "Scope", "Driver", "EnableIPv4", "EnableIPv6", "IPAM",
          "Internal", "Attachable", "Ingress", "ConfigFrom", "ConfigOnly", "Options", "Labels")
HEX64 = r"[0-9a-f]{64}"
MAX_SECONDS = 30


class Denied(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Denied(code)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def now():
    return datetime.now(timezone.utc).isoformat()


def normalize_bridge(raw, container_ids):
    require(isinstance(raw, dict) and all(k in raw for k in STABLE), "BRIDGE_FIELDS_MISSING")
    require(raw.get("Name") == "bridge" and raw.get("Driver") == "bridge"
            and raw.get("Internal") is False, "DEFAULT_BRIDGE_REQUIRED")
    require(isinstance(raw.get("Id"), str) and re.fullmatch(HEX64, raw["Id"])
            and isinstance(raw.get("Created"), str) and 0 < len(raw["Created"]) <= 100, "BRIDGE_IDENTITY_MISSING")
    endpoints = raw.get("Containers")
    require(isinstance(endpoints, dict) and len(endpoints) <= 64, "BRIDGE_ATTACHMENTS_UNREADABLE")
    attachments = []
    for key, item in sorted(endpoints.items()):
        require(re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", key) and isinstance(item, dict), "ATTACHMENT_INVALID")
        endpoint_id, name = item.get("EndpointID"), item.get("Name")
        require(isinstance(endpoint_id, str) and re.fullmatch(HEX64, endpoint_id), "ENDPOINT_ID_MISSING")
        require(isinstance(name, str) and 0 < len(name) <= 256, "ENDPOINT_NAME_MISSING")
        kind = ("ENGINE_CONTAINER" if key in container_ids else
                "ORPHAN_ENDPOINT" if key == "ep-" + endpoint_id else "UNATTRIBUTED_SANDBOX")
        attachments.append({"attachmentId": key, "endpointId": endpoint_id, "kind": kind,
                            "nameSha256": sha(name.encode()), "nameEqualsAttachmentId": name == key})
    return {"id": raw["Id"], "created": raw["Created"],
            "stablePropertiesSha256": sha(encoded({k: raw[k] for k in STABLE})),
            "attachments": attachments}


class DockerReadOnly:
    """Fixed commands, explicit context, bounded reads, no raw diagnostic output."""

    def __init__(self, context, *, clock=time.monotonic):
        self.context = context
        self.clock = clock
        self.deadline = clock() + MAX_SECONDS

    def query(self, *args):
        remaining = self.deadline - self.clock()
        require(remaining > 0, "BOUNDARY_READ_BUDGET_EXHAUSTED")
        try:
            result = subprocess.run(["docker", "--context", self.context, *args],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                    timeout=min(5, remaining), check=False)
            require(result.returncode == 0, "DOCKER_METADATA_READ_FAILED")
            require(len(result.stdout) <= 2_000_000, "DOCKER_METADATA_TOO_LARGE")
            return result.stdout.decode("utf-8", errors="strict").strip()
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            raise Denied("DOCKER_METADATA_READ_UNCERTAIN") from None

    def json(self, *args):
        try:
            return json.loads(self.query(*args))
        except (ValueError, TypeError):
            raise Denied("DOCKER_METADATA_INVALID_JSON") from None

    def snapshot(self, binding):
        def identity():
            engine = self.query("info", "--format", "{{.ID}}")
            endpoint = self.query("context", "inspect", self.context, "--format",
                                  '{{ (index .Endpoints "docker").Host }}')
            require(engine == binding["engine"] and endpoint == binding["endpoint"], "ENGINE_OR_ENDPOINT_DRIFT")
        identity()
        ids = self.query("ps", "-aq", "--no-trunc").splitlines()
        require(len(ids) <= 128 and len(ids) == len(set(ids)) and
                all(re.fullmatch(HEX64, v) for v in ids), "CONTAINER_INVENTORY_INVALID")
        # Select fields explicitly; never read Config.Env, logs, credentials or DB.
        containers = []
        projection = ('{"id":{{json .Id}},"created":{{json .Created}},"image":{{json .Image}},'
                      '"state":{{json .State.Status}},"started":{{json .State.StartedAt}},'
                      '"finished":{{json .State.FinishedAt}},"restarts":{{json .RestartCount}}}')
        if ids:
            lines = self.query("inspect", "--type", "container", "--format", projection, *sorted(ids)).splitlines()
            try:
                containers = [json.loads(line) for line in lines]
                require([c["id"] for c in containers] == sorted(ids), "CONTAINER_INVENTORY_INCOMPLETE")
                for c in containers:
                    require(set(c) == {"id", "created", "image", "state", "started", "finished", "restarts"}
                            and all(isinstance(c[k], str) and c[k] for k in ("created", "image", "state", "started", "finished"))
                            and type(c["restarts"]) is int and c["restarts"] >= 0, "CONTAINER_STATE_INCOMPLETE")
            except (ValueError, KeyError, TypeError):
                raise Denied("CONTAINER_INVENTORY_INCOMPLETE") from None
        volumes = self.query("volume", "ls", "--format", "{{json .}}").splitlines()
        networks = self.query("network", "ls", "--no-trunc", "--format", "{{json .}}").splitlines()
        require(len(volumes) <= 128 and len(networks) <= 128, "RESOURCE_INVENTORY_TOO_LARGE")
        try:
            volumes = sorted((v["Name"], v["Driver"], v["Scope"]) for v in map(json.loads, volumes))
            networks = sorted((v["ID"], v["Name"], v["Driver"], v["Scope"]) for v in map(json.loads, networks))
            require(all(re.fullmatch(HEX64, v[0]) for v in networks), "NETWORK_INVENTORY_INVALID")
        except (KeyError, TypeError, ValueError):
            raise Denied("RESOURCE_INVENTORY_INVALID") from None
        bridge = normalize_bridge(self.json("network", "inspect", "bridge", "--format", "{{json .}}"), ids)
        require(any(n[0] == bridge["id"] and n[1] == "bridge" for n in networks), "BRIDGE_INVENTORY_MISMATCH")
        identity()
        # Historical names, IP/MAC, labels and raw config stay out of the evidence.
        return {"bridge": bridge, "containersSha256": sha(encoded(containers)),
                "volumesSha256": sha(encoded(volumes)), "networksSha256": sha(encoded(networks)),
                "counts": {"containers": len(ids), "volumes": len(volumes), "networks": len(networks)}}


def compare(before, after):
    for key in ("containersSha256", "volumesSha256", "networksSha256", "counts"):
        require(before[key] == after[key], "HISTORICAL_RESOURCES_CHANGED")
    for key in ("id", "created", "stablePropertiesSha256"):
        require(before["bridge"][key] == after["bridge"][key], "BRIDGE_IDENTITY_OR_CONFIG_CHANGED")
    require(not any(a["kind"] in ("ENGINE_CONTAINER", "ORPHAN_ENDPOINT") for a in after["bridge"]["attachments"]),
            "DEFAULT_BRIDGE_FORBIDDEN_ATTACHMENT")
    return not after["bridge"]["attachments"]


def write_new(path, value):
    with path.open("xb") as stream:
        stream.write(encoded(value))


def validate_binding(args):
    require(args.contract == CONTRACT, "NEW_NETWORK_CONTRACT_REQUIRED")
    require(re.fullmatch(r"[a-zA-Z0-9_.-]{1,80}", args.context or ""), "CONTEXT_INVALID")
    require(re.fullmatch(r"[a-zA-Z0-9:-]{1,100}", args.engine or ""), "ENGINE_INVALID")
    require(args.endpoint in ENDPOINTS, "NONLOCAL_ENDPOINT_FORBIDDEN")
    require(re.fullmatch(r"[0-9a-f]{40}", args.head or "") and
            re.fullmatch(r"[0-9a-f]{40}", args.tree or ""), "SOURCE_BINDING_INVALID")
    require(re.fullmatch(r"fai-vnx03-[a-z0-9-]+", args.project or ""), "PROJECT_BINDING_INVALID")
    return {k: getattr(args, k) for k in ("contract", "context", "engine", "endpoint", "head", "tree", "project")}


def execute(args, *, transport=None, clock=time.monotonic, sleep=time.sleep):
    binding = validate_binding(args)  # Denial precedes even transport construction.
    directory = Path(args.directory)
    result_path = directory / ("baseline-result.json" if args.mode == "prepare" else "boundary-result.json")
    observation_path = directory / ("before-build.jsonl" if args.mode == "prepare" else "after-build.jsonl")
    if args.mode == "prepare":
        directory.mkdir(exist_ok=False)
    require(directory.is_dir() and not directory.is_symlink(), "BOUNDARY_DIRECTORY_INVALID")
    require(not result_path.exists() and not observation_path.exists(), "BOUNDARY_ALREADY_ATTEMPTED")
    baseline_path = directory / "baseline.json"
    result = {"contract": CONTRACT, "binding": binding, "status": "STOP", "runtimeQualified": False,
              "endpointAttributionProven": False, "recordedUtc": now()}
    started = clock()
    try:
        if args.mode == "admit":
            require(args.baseline_sha and re.fullmatch(HEX64, args.baseline_sha), "BASELINE_DIGEST_REQUIRED")
            require(baseline_path.is_file() and not baseline_path.is_symlink(), "BASELINE_FILE_INVALID")
            raw = baseline_path.read_bytes()
            require(sha(raw) == args.baseline_sha, "BASELINE_CHANGED")
            baseline = json.loads(raw)
            require(baseline["binding"] == binding and not baseline["snapshot"]["bridge"]["attachments"], "BASELINE_BINDING_INVALID")
            result["baselineSha256"] = args.baseline_sha
        reader = transport if transport is not None else DockerReadOnly(args.context, clock=clock)
        reader.deadline = started + MAX_SECONDS
        with observation_path.open("xb") as journal:
            consecutive_empty = 0
            while clock() - started < MAX_SECONDS:
                sample = reader.snapshot(binding)
                journal.write(encoded({"recordedUtc": now(), "elapsedSeconds": round(clock() - started, 3), "snapshot": sample}))
                journal.flush()  # Preserve the observation BEFORE any decision/assertion.
                require(clock() - started < MAX_SECONDS, "BOUNDARY_READ_BUDGET_EXHAUSTED")
                if args.mode == "prepare":
                    require(not sample["bridge"]["attachments"], "BASELINE_BRIDGE_NOT_EMPTY")
                    value = {"binding": binding, "recordedUtc": now(), "snapshot": sample}
                    write_new(baseline_path, value)
                    result.update(status="BASELINE_RECORDED", baselineSha256=sha(encoded(value)))
                    break
                empty = compare(baseline["snapshot"], sample)
                consecutive_empty = consecutive_empty + 1 if empty else 0
                if consecutive_empty == 2:
                    result.update(status="ADMITTED_BOUNDARY_ONLY", consecutiveEmptySamples=2)
                    break
                sleep(min(1, max(0, MAX_SECONDS - (clock() - started))))
            else:
                raise Denied("POST_BUILD_BRIDGE_NOT_QUIESCENT")
    except Denied as error:
        result["code"] = str(error)
    except (OSError, ValueError, KeyError, TypeError):
        result["code"] = "BOUNDARY_EVIDENCE_UNCERTAIN"
    result["elapsedSeconds"] = round(clock() - started, 3)
    if observation_path.exists():
        result["observationsSha256"] = sha(observation_path.read_bytes())
    write_new(result_path, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "admit"))
    for key in ("directory", "contract", "context", "engine", "endpoint", "head", "tree", "project"):
        parser.add_argument("--" + key, required=True)
    parser.add_argument("--baseline-sha")
    try:
        result = execute(parser.parse_args())
        # Only a digest is returned to the shell; raw command output is private.
        if result["status"] == "BASELINE_RECORDED":
            print(result["baselineSha256"])
        elif result["status"] != "ADMITTED_BOUNDARY_ONLY":
            print(result.get("code", "BOUNDARY_STOP"), file=sys.stderr)
        return 0 if result["status"] != "STOP" else 1
    except (Denied, OSError):
        print("VNX03_PRO_NETWORK_BOUNDARY_DENIED", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
