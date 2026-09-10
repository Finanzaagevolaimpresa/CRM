"""N05 failed-application return protocol.

This module deliberately does not share the key-mount approval or schema gate.
It implements a two-command protocol: ``forward`` records every observable
transition, and ``return`` can replace only the app created by that receipt.
The production entry point at the bottom has fixed Docker/Compose selectors;
tests exercise :class:`ReturnController` with an isolated engine.
"""
from __future__ import annotations

import copy
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time


class Denied(Exception):
    pass


def require(value, code):
    if not value:
        raise Denied(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def strict_json(path: Path):
    def unique(pairs):
        out = {}
        for key, value in pairs:
            require(key not in out, "DUPLICATE_JSON_KEY")
            out[key] = value
        return out
    def invalid_constant(_):
        raise Denied("NON_FINITE_JSON_NUMBER")
    with path.open(encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=unique, parse_constant=invalid_constant)


def private_file(path: Path, *, may_create=False):
    require(path.is_absolute() and ".." not in path.parts, "PRIVATE_PATH_INVALID")
    parent = path.parent
    ps = parent.lstat()
    require(stat.S_ISDIR(ps.st_mode) and not stat.S_ISLNK(ps.st_mode), "PRIVATE_PARENT_INVALID")
    require(ps.st_uid in {0, os.getuid()} and stat.S_IMODE(ps.st_mode) == 0o700,
            "PRIVATE_PARENT_OWNER_MODE")
    for ancestor in parent.parents:
        s = ancestor.lstat()
        require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and
                s.st_uid in {0, os.getuid()} and not s.st_mode & 0o022, "PRIVATE_PATH_ANCESTOR_UNTRUSTED")
    if not may_create or path.exists():
        s = path.lstat()
        require(stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_nlink == 1,
                "PRIVATE_FILE_NOT_REGULAR")
        require(s.st_uid in {0, os.getuid()} and stat.S_IMODE(s.st_mode) == 0o600,
                "PRIVATE_FILE_OWNER_MODE")


def atomic_json(path: Path, value):
    private_file(path, may_create=True)
    fd, name = tempfile.mkstemp(prefix=".n05-", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(canonical(value) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        dfd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def acquire_lock(path: Path, binding):
    private_file(path, may_create=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise Denied("RETURN_LOCK_CONTENDED")
        expected = canonical(binding) + "\n"
        current = os.read(fd, 4096).decode()
        require(not current or current == expected, "LOCK_BINDING_MISMATCH")
        if not current:
            os.write(fd, expected.encode()); os.fsync(fd)
        return fd
    except BaseException:
        os.close(fd)
        raise


def run_deadline(command, env, deadline, input_text=None):
    remaining = deadline-time.time()
    require(remaining > 0, "DEADLINE_EXPIRED")
    process = subprocess.Popen(command, stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env,
                               start_new_session=True)
    try:
        stdout, stderr = process.communicate(input_text, timeout=remaining)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, 9); process.communicate()
        raise Denied("SUBPROCESS_DEADLINE_EXPIRED")
    return process.returncode, stdout, stderr


OID = re.compile(r"^[0-9a-f]{40}$")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
RUN_ID = re.compile(r"^[a-z0-9][a-z0-9-]{15,79}$")

PLAN_KEYS = {"schema", "run_id", "engine", "project", "tools", "source_app", "candidate", "return_image",
             "postgres", "resources", "configs", "ledger", "compatibility", "deadline_epoch", "gates",
             "return_reason", "migrator", "receipt_path", "journal_path"}
IMAGE_KEYS = {"tag", "id", "oci_commit", "oci_tree"}
REF_KEYS = {"path", "sha256", "kind"}
VOLUME_KEYS = {"Name","Driver","Mountpoint","CreatedAt","Labels","Options","Scope"}
NETWORK_KEYS = {"Id","Name","Created","Driver","Scope","Labels","Options","IPAM","Internal","Attachable","Ingress"}


def validate_ref(value, kind):
    require(type(value) is dict and set(value) == REF_KEYS and value["kind"] == kind,
            "EVIDENCE_REFERENCE_INVALID")
    require(type(value["path"]) is str and Path(value["path"]).is_absolute(), "EVIDENCE_PATH_INVALID")
    require(type(value["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", value["sha256"]),
            "EVIDENCE_DIGEST_INVALID")


def validate_evidence(reference, plan, expected_binding):
    validate_ref(reference, reference["kind"])
    path = Path(reference["path"]); private_file(path)
    raw = path.read_bytes()
    require(hashlib.sha256(raw).hexdigest() == reference["sha256"], "EVIDENCE_FILE_DIGEST_MISMATCH")
    document = strict_json(path)
    require(type(document) is dict and set(document) == {"schema", "kind", "synthetic", "binding", "result", "details"},
            "EVIDENCE_SCHEMA_INVALID")
    require(document["schema"] == "FAI_CRM_N05_EVIDENCE_V1" and document["kind"] == reference["kind"],
            "EVIDENCE_KIND_INVALID")
    require(document["synthetic"] is False and document["result"] == "qualified", "PRODUCTION_EVIDENCE_NOT_QUALIFIED")
    require(type(document["binding"]) is dict and document["binding"] == expected_binding,
            "EVIDENCE_BINDING_INVALID")
    require(type(document["details"]) is dict and document["details"], "EVIDENCE_DETAILS_INVALID")
    return document


def validate_plan(plan, now=None):
    require(type(plan) is dict and set(plan) == PLAN_KEYS, "PLAN_SCHEMA_INVALID")
    require(plan["schema"] == "FAI_CRM_N05_FAILED_APP_RETURN_V2", "PLAN_VERSION_INVALID")
    require(isinstance(plan["run_id"], str) and RUN_ID.fullmatch(plan["run_id"]), "RUN_ID_INVALID")
    require(type(plan["engine"]) is dict and set(plan["engine"]) == {"kind", "host", "id", "name", "os_type"}
            and plan["engine"]["kind"] == "docker" and plan["engine"]["host"] == "unix:///var/run/docker.sock"
            and all(type(plan["engine"][k]) is str and plan["engine"][k] for k in ("id", "name"))
            and plan["engine"]["os_type"] == "linux", "ENGINE_SELECTOR_INVALID")
    require(plan["project"] == "fai-crm" or re.fullmatch(r"fai-crm-n05-synthetic-[a-f0-9]{12}", plan["project"]),
            "PROJECT_INVALID")
    require(set(plan["tools"]) == {"commit", "tree", "ci_sha", "ci_conclusion"}, "TOOLS_INVALID")
    require(plan["tools"]["ci_conclusion"] == "success" and
            plan["tools"]["ci_sha"] == plan["tools"]["commit"], "TOOLS_CI_INVALID")
    for value in (plan["tools"]["commit"], plan["tools"]["tree"]):
        require(isinstance(value, str) and OID.fullmatch(value), "TOOLS_OID_INVALID")
    for name in ("candidate", "return_image"):
        require(set(plan[name]) == IMAGE_KEYS, "IMAGE_SPEC_INVALID")
        require(IMAGE_ID.fullmatch(plan[name]["id"]), "IMAGE_ID_INVALID")
        require(all(OID.fullmatch(plan[name][key]) for key in ("oci_commit", "oci_tree")),
                "IMAGE_PROVENANCE_INVALID")
    require(type(plan["source_app"]) is dict and set(plan["source_app"]) == {"id", "created", "image_id"}
            and re.fullmatch(r"[0-9a-f]{64}",plan["source_app"]["id"])
            and IMAGE_ID.fullmatch(plan["source_app"]["image_id"])
            and type(plan["source_app"]["created"]) is str and plan["source_app"]["created"],
            "SOURCE_APP_SPEC_INVALID")
    if plan["migrator"] is not None:
        require(type(plan["migrator"]) is dict and set(plan["migrator"]) == {"id","created","image_id","role","project"}
                and plan["migrator"]["role"] == "migrate" and plan["migrator"]["project"] == plan["project"]
                and re.fullmatch(r"[0-9a-f]{64}",plan["migrator"]["id"])
                and IMAGE_ID.fullmatch(plan["migrator"]["image_id"])
                and type(plan["migrator"]["created"]) is str and plan["migrator"]["created"],
                "MIGRATOR_SPEC_INVALID")
    require(set(plan["postgres"]) == {"id", "image", "created"}, "POSTGRES_SPEC_INVALID")
    require(re.fullmatch(r"[0-9a-f]{64}",plan["postgres"]["id"]) and IMAGE_ID.fullmatch(plan["postgres"]["image"])
            and type(plan["postgres"]["created"]) is str and plan["postgres"]["created"], "POSTGRES_IMAGE_INVALID")
    require(set(plan["resources"]) == {"volumes", "network"} and
            set(plan["resources"]["volumes"]) == {"crm_documents", "postgres_data"},
            "RESOURCE_SPEC_INVALID")
    for volume in plan["resources"]["volumes"].values():
        require(type(volume) is dict and set(volume) == VOLUME_KEYS and
                all(type(volume[k]) is str and volume[k] for k in ("Name","Driver","Mountpoint","CreatedAt","Scope"))
                and type(volume["Labels"]) is dict and type(volume["Options"]) is dict, "VOLUME_SPEC_INVALID")
    network = plan["resources"]["network"]
    require(type(network) is dict and set(network) == NETWORK_KEYS and re.fullmatch(r"[0-9a-f]{64}",network["Id"])
            and all(type(network[k]) is str and network[k] for k in ("Name","Created","Driver","Scope"))
            and all(type(network[k]) is dict for k in ("Labels","Options","IPAM"))
            and all(type(network[k]) is bool for k in ("Internal","Attachable","Ingress")), "NETWORK_SPEC_INVALID")
    require(set(plan["configs"]) == {"previous", "candidate", "return"}, "CONFIG_SPEC_INVALID")
    for name, value in plan["configs"].items(): validate_ref(value, "frozen-compose-" + name)
    require(set(plan["ledger"]) == {"schema", "count", "digest"} and type(plan["ledger"]["schema"]) is str
            and type(plan["ledger"]["count"]) is int and plan["ledger"]["count"] > 0
            and re.fullmatch(r"[0-9a-f]{64}", plan["ledger"]["digest"]), "LEDGER_SPEC_INVALID")
    validate_ref(plan["compatibility"], "return-image-schema-compatibility")
    require(set(plan["gates"]) == {"recovery", "artifacts", "reviewed_plan", "authorization"} and
            all(type(x) is dict for x in plan["gates"].values()), "PRODUCTION_GATES_INCOMPLETE")
    for kind, value in plan["gates"].items(): validate_ref(value, kind)
    require(type(plan["return_reason"]) is dict and set(plan["return_reason"]) == {"kind", "evidence"}
            and plan["return_reason"]["kind"] in {"functional-failure", "unhealthy", "exited", "absent"},
            "RETURN_REASON_INVALID")
    if plan["return_reason"]["kind"] == "functional-failure":
        validate_ref(plan["return_reason"]["evidence"], "functional-failure")
    else:
        require(plan["return_reason"]["evidence"] is None, "RETURN_REASON_EVIDENCE_UNEXPECTED")
    for key in ("receipt_path", "journal_path"):
        require(type(plan[key]) is str and Path(plan[key]).is_absolute(), "PRIVATE_OUTPUT_PATH_INVALID")
    require(type(plan["deadline_epoch"]) in (int, float) and plan["deadline_epoch"] > (now or time.time()),
            "DEADLINE_EXPIRED")
    return plan


def event(previous, run_id, phase, result, observation):
    body = {"run_id": run_id, "sequence": 1 if previous is None else previous["sequence"] + 1,
            "phase": phase, "result": result, "observation": observation,
            "previous_sha256": None if previous is None else sha(previous)}
    body["event_sha256"] = sha(body)
    return body


def validate_receipt(receipt, plan):
    require(set(receipt) == {"schema", "run_id", "engine", "project", "plan_sha256", "lock_id", "events"}, "RECEIPT_SCHEMA_INVALID")
    require(receipt["schema"] == "FAI_CRM_N05_FORWARD_RECEIPT_V1" and
            receipt["run_id"] == plan["run_id"] and receipt["engine"] == plan["engine"] and
            receipt["project"] == plan["project"] and receipt["plan_sha256"] == sha(plan) and
            receipt["lock_id"] == plan["engine"]["id"] + ":" + plan["project"], "RECEIPT_BINDING_INVALID")
    require(isinstance(receipt["events"], list) and receipt["events"], "RECEIPT_EMPTY")
    previous = None
    for current in receipt["events"]:
        require(set(current) == {"run_id", "sequence", "phase", "result", "observation",
                                 "previous_sha256", "event_sha256"}, "EVENT_SCHEMA_INVALID")
        claimed = current["event_sha256"]
        require(claimed == sha({k: v for k, v in current.items() if k != "event_sha256"}), "EVENT_HASH_INVALID")
        require(current["run_id"] == plan["run_id"] and current["sequence"] == (1 if previous is None else previous["sequence"] + 1)
                and current["previous_sha256"] == (None if previous is None else sha(previous)), "EVENT_CHAIN_INVALID")
        previous = current
    phases = [x["phase"] for x in receipt["events"]]
    prefix = ["healthy-source", "boundary-verified", "transition-intent", "old-app-removed", "candidate-create"]
    require(phases[:5] == prefix and phases[-1] == "forward-result", "FORWARD_SEQUENCE_INCOMPLETE")
    require(receipt["events"][0]["result"] == "verified" and
            receipt["events"][3]["result"] == "observed-exact", "FORWARD_TRANSITION_UNPROVEN")
    source_observation = receipt["events"][0]["observation"]
    require(type(source_observation) is dict and source_observation == plan["source_app"], "RECEIPT_SOURCE_IDENTITY_INVALID")
    require(receipt["events"][1]["observation"] == {"snapshot_sha256":receipt["events"][1]["observation"].get("snapshot_sha256")}
            and re.fullmatch(r"[0-9a-f]{64}",receipt["events"][1]["observation"]["snapshot_sha256"]),
            "RECEIPT_BOUNDARY_INVALID")
    require(receipt["events"][2]["observation"] == {"app_only":True,"no_deps":True}, "RECEIPT_INTENT_INVALID")
    require(receipt["events"][3]["observation"] == {"id":plan["source_app"]["id"],"inventory_complete":True},
            "RECEIPT_REMOVAL_INVALID")
    final = receipt["events"][-1]
    if final["result"] == "candidate-observed":
        require(phases == prefix + ["candidate-start", "forward-result"] and
                receipt["events"][4]["result"] == "created-exact" and
                receipt["events"][5]["result"] == "started-exact", "CANDIDATE_SEQUENCE_INCOMPLETE")
        created = receipt["events"][4]["observation"].get("candidate")
        require(type(created) is dict and set(created) == {"id","created","image_id"}
                and re.fullmatch(r"[0-9a-f]{64}",created["id"]) and created["image_id"] == plan["candidate"]["id"]
                and receipt["events"][5]["observation"] == {"candidate":created}
                and final["observation"] == {"candidate":created}, "CANDIDATE_RECEIPT_IDENTITY_INVALID")
    elif final["result"] == "candidate-absent-attributed":
        require(phases == prefix + ["forward-result"] and receipt["events"][4]["result"] == "absence-observed"
                and receipt["events"][4]["observation"] == {"inventory_complete": True, "app": None}
                and final["observation"] == {"absence_proven_by_sequence": True}, "ABSENCE_SEQUENCE_UNPROVEN")
    else:
        raise Denied("FORWARD_RESULT_INCOMPLETE")
    return final


class ForwardRecorder:
    """Receipt producer surrounding a controlled, app-only forward transition."""
    def __init__(self, engine, clock=time.time): self.engine, self.clock = engine, clock

    def run(self, plan, receipt_path):
        validate_plan(plan, self.clock())
        require(self.engine.config_digest("candidate", plan["deadline_epoch"]) == plan["configs"]["candidate"]["sha256"],
                "CANDIDATE_CONFIG_DRIFT")
        require(self.engine.image(plan["candidate"], plan["deadline_epoch"]), "CANDIDATE_IMAGE_UNAVAILABLE")
        before = self.engine.snapshot(plan["deadline_epoch"])
        require(before["app"] and before["app"]["state"] == "healthy" and
                {k:before["app"][k] for k in ("id","created","image_id")} == plan["source_app"] and
                before["app"]["config_sha256"] == plan["configs"]["previous"]["sha256"], "FORWARD_SOURCE_NOT_HEALTHY")
        self.engine.validate_boundary(plan, before, plan["deadline_epoch"])
        events = [event(None, plan["run_id"], "healthy-source", "verified",
                        {"id": before["app"]["id"], "created": before["app"]["created"],
                         "image_id": before["app"]["image_id"]})]
        receipt = {"schema":"FAI_CRM_N05_FORWARD_RECEIPT_V1", "run_id":plan["run_id"],
                   "engine":plan["engine"], "project":plan["project"], "plan_sha256":sha(plan),
                   "lock_id":plan["engine"]["id"]+":"+plan["project"], "events":events}
        atomic_json(receipt_path, receipt)
        events.append(event(events[-1], plan["run_id"], "boundary-verified", "verified", {"snapshot_sha256":sha(before)}))
        atomic_json(receipt_path, receipt)
        events.append(event(events[-1], plan["run_id"], "transition-intent", "authorized", {"app_only":True,"no_deps":True}))
        atomic_json(receipt_path, receipt)
        try:
            self.engine.remove_source(plan["source_app"]["id"], plan["deadline_epoch"])
            absence = self.engine.observe_app_absence(plan["deadline_epoch"])
            require(absence is True, "SOURCE_REMOVAL_UNOBSERVED")
            events.append(event(events[-1], plan["run_id"], "old-app-removed", "observed-exact",
                                {"id":plan["source_app"]["id"],"inventory_complete":True}))
            atomic_json(receipt_path, receipt)
            created = self.engine.create_candidate(plan, plan["deadline_epoch"])
            if created is None:
                require(self.engine.observe_app_absence(plan["deadline_epoch"]) is True, "CANDIDATE_ABSENCE_UNCERTAIN")
                events.append(event(events[-1], plan["run_id"], "candidate-create", "absence-observed",
                                    {"inventory_complete":True,"app":None}))
                events.append(event(events[-1], plan["run_id"], "forward-result", "candidate-absent-attributed",
                                    {"absence_proven_by_sequence":True}))
                atomic_json(receipt_path, receipt)
                return receipt
            events.append(event(events[-1], plan["run_id"], "candidate-create", "created-exact", {"candidate":created}))
            atomic_json(receipt_path, receipt)
            self.engine.start_candidate(created["id"], plan["deadline_epoch"])
            observed = self.engine.snapshot(plan["deadline_epoch"])["app"]
            require(observed and {k:observed[k] for k in ("id","created","image_id")} == created,
                    "CANDIDATE_START_IDENTITY_DRIFT")
            events.append(event(events[-1], plan["run_id"], "candidate-start", "started-exact", {"candidate":created}))
            events.append(event(events[-1], plan["run_id"], "forward-result", "candidate-observed",
                                {"candidate":created}))
        except (Denied, subprocess.SubprocessError):
            # Persist the incomplete chain. It is evidence, never return authority.
            atomic_json(receipt_path, receipt)
            raise
        atomic_json(receipt_path, receipt)
        return receipt


def finish_registered_migrator(engine, plan):
    """Remove only the recorded migrator after exit and resulting-ledger proof."""
    expected = plan["migrator"]
    require(expected is not None, "MIGRATOR_ID_MISSING")
    registered_id = expected["id"]
    observed = engine.migrator(registered_id, plan["deadline_epoch"])
    require(observed and {k:observed[k] for k in ("id","created","image_id","role","project")} == expected
            and observed["state"] == "exited" and
            observed["exit_code"] == 0, "MIGRATOR_NOT_SUCCESSFULLY_EXITED")
    snapshot = engine.snapshot(plan["deadline_epoch"])
    require(snapshot["ledger"] == plan["ledger"], "MIGRATOR_LEDGER_INCOMPLETE")
    engine.remove_migrator(registered_id, plan["deadline_epoch"])
    require(engine.migrator(registered_id, plan["deadline_epoch"]) is None, "MIGRATOR_REMOVAL_FAILED")
    after = engine.snapshot(plan["deadline_epoch"])
    require(after["postgres"] == plan["postgres"] and after["resources"] == plan["resources"] and
            not after["migrators"] and not after["foreign_containers"], "POST_MIGRATOR_INVENTORY_DRIFT")


class ReturnController:
    """Protocol logic. Engine methods are deadline-aware and fail closed."""
    def __init__(self, engine, clock=time.time):
        self.engine, self.clock = engine, clock

    def _check(self, plan, receipt=None):
        require(self.clock() < plan["deadline_epoch"], "DEADLINE_EXPIRED")
        snapshot = self.engine.snapshot(plan["deadline_epoch"])
        require(snapshot["engine"] == plan["engine"] and snapshot["project"] == plan["project"], "ENGINE_PROJECT_DRIFT")
        require(snapshot["postgres"] == plan["postgres"] and snapshot["resources"] == plan["resources"], "PERSISTENT_RESOURCE_DRIFT")
        require(snapshot["postgres_healthy"], "POSTGRES_NOT_HEALTHY")
        require(snapshot["migrators"] == [], "MIGRATOR_PRESENT")
        require(snapshot["foreign_containers"] == [], "FOREIGN_CONTAINER_PRESENT")
        require(snapshot["ledger"] == plan["ledger"], "LEDGER_DRIFT")
        if receipt:
            final = validate_receipt(receipt, plan)
            app = snapshot["app"]
            if final["result"] == "candidate-observed":
                expected = final["observation"]["candidate"]
                require(app is not None and {k: app[k] for k in ("id", "created", "image_id")} == expected,
                        "CANDIDATE_IDENTITY_DRIFT")
                require(app["config_sha256"] == plan["configs"]["candidate"]["sha256"], "CANDIDATE_CONFIG_DRIFT")
                reason = plan["return_reason"]["kind"]
                allowed = ((reason == "functional-failure" and app["state"] == "healthy") or
                           (reason == "unhealthy" and app["state"] == "running-unhealthy") or
                           (reason == "exited" and app["state"] == "exited"))
                require(allowed, "CANDIDATE_STATE_NOT_RETURNABLE")
            else:
                require(plan["return_reason"]["kind"] == "absent" and app is None and
                        final["observation"] == {"absence_proven_by_sequence": True},
                        "ABSENCE_NOT_ATTRIBUTED")
        return snapshot

    def return_app(self, plan, receipt, journal_path):
        validate_plan(plan, self.clock())
        require(not journal_path.exists(), "RETURN_ALREADY_ATTEMPTED")
        require(not self.engine.attempted(plan["run_id"]), "RETURN_ALREADY_ATTEMPTED")
        before = self._check(plan, receipt)
        require(self.engine.image(plan["return_image"], plan["deadline_epoch"]), "RETURN_IMAGE_UNAVAILABLE")
        require(self.engine.config_digest("return", plan["deadline_epoch"]) == plan["configs"]["return"]["sha256"], "RETURN_CONFIG_DRIFT")
        self.engine.mark_attempt(plan["run_id"])
        journal = {"schema":"FAI_CRM_N05_RETURN_JOURNAL_V1", "run_id":plan["run_id"],
                   "result":"ATTEMPT_STARTED", "plan_sha256":sha(plan), "receipt_sha256":sha(receipt),
                   "before_snapshot_sha256":sha(before)}
        atomic_json(journal_path, journal)
        try:
            new_id = self.engine.recreate_return(plan, plan["deadline_epoch"])
            require(new_id and (before["app"] is None or new_id != before["app"]["id"]), "NEW_APP_ID_REQUIRED")
            after = self._check(plan)
            app = after["app"]
            require(app and app["id"] == new_id and app["state"] == "healthy" and
                    app["image_id"] == plan["return_image"]["id"] and
                    app["config_sha256"] == plan["configs"]["return"]["sha256"], "RETURN_APP_NOT_VERIFIED")
            require(after["postgres"] == before["postgres"] and after["resources"] == before["resources"],
                    "RETURN_CHANGED_PERSISTENCE")
        except BaseException as error:
            journal.update(result="FAILED", failure=error.args[0] if isinstance(error, Denied) else "SAFE_MUTATION_FAILURE")
            atomic_json(journal_path, journal)
            raise
        journal.update(result="PASS", new_app_id=new_id, final_snapshot_sha256=sha(after))
        atomic_json(journal_path, journal)
        return journal


class DockerEngine:
    """Fixed production Docker adapter; no caller-controlled executable or host."""
    def __init__(self, plan, repo, *, files=None, env_file=None, command=None,
                 synthetic_candidate_absence=False, created_callback=None):
        self.plan, self.repo = plan, repo
        self.project = plan["project"]
        self.command = command or ["docker", "--host", "unix:///var/run/docker.sock"]
        self.files = files or [repo / "docker-compose.prod.example.yml", repo / "docker-compose.prod.legacy-resources.yml"]
        self.env_file = env_file or repo / ".env.production"
        self._attempt = False
        self.synthetic_candidate_absence = synthetic_candidate_absence
        self.created_callback = created_callback or (lambda _identity: None)

    def run(self, *args, deadline, input_text=None):
        remaining = deadline - time.time()
        require(remaining > 0, "DEADLINE_EXPIRED")
        env = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ} | {"LC_ALL": "C"}
        status, stdout, _ = run_deadline(self.command+list(args),env,deadline,input_text)
        require(status == 0, "DOCKER_COMMAND_FAILED")
        return stdout

    def inspect(self, kind, identity, deadline):
        return json.loads(self.run(kind, "inspect", identity, deadline=deadline))[0]

    def ids(self, service, deadline):
        return self.run("ps", "-aq", "--no-trunc", "--filter", f"label=com.docker.compose.project={self.project}",
                        "--filter", f"label=com.docker.compose.service={service}", deadline=deadline).split()

    def model(self, image, deadline):
        remaining = deadline - time.time(); require(remaining > 0, "DEADLINE_EXPIRED")
        env = {k: os.environ[k] for k in ("PATH", "HOME") if k in os.environ}
        env.update({"APP_IMAGE": image, "APP_ENV_FILE": str(self.env_file), "COMPOSE_PROJECT_NAME": self.project})
        command = self.command + ["compose", "-p", self.project, "--project-directory", str(self.repo),
          "--env-file", str(self.env_file), *[x for f in self.files for x in ("-f", str(f))],
          "config", "--format", "json"]
        status, stdout, _ = run_deadline(command,env,deadline)
        require(status == 0, "COMPOSE_CONFIG_FAILED")
        return json.loads(stdout)

    def config_digest(self, which, deadline):
        reference = self.plan["configs"][which]
        path = Path(reference["path"]); private_file(path)
        model = strict_json(path)
        require(sha(model) == reference["sha256"], "FROZEN_CONFIG_FILE_DRIFT")
        remaining = deadline-time.time(); require(remaining > 0, "DEADLINE_EXPIRED")
        env = {k:os.environ[k] for k in ("PATH","HOME") if k in os.environ}
        command = self.command + ["compose","-p",self.project,"--project-directory",str(self.repo),
                                   "--env-file",str(self.env_file),"-f",str(path),"config","--format","json"]
        status, stdout, _ = run_deadline(command,env,deadline)
        require(status == 0 and json.loads(stdout) == model, "FROZEN_COMPOSE_REPLAY_MISMATCH")
        return sha(model)

    @staticmethod
    def image_observation(raw):
        labels = raw.get("Config", {}).get("Labels") or {}
        return {"tag": raw.get("RepoTags", [""])[0], "id": raw["Id"],
                "oci_commit": labels.get("org.opencontainers.image.revision"),
                "oci_tree": labels.get("it.finanzaagevolaimpresa.source-tree")}

    def image(self, spec, deadline):
        try:
            raw = self.inspect("image", spec["id"], deadline)
        except Denied:
            return False
        labels = raw.get("Config", {}).get("Labels") or {}
        return raw["Id"] == spec["id"] and spec["tag"] in (raw.get("RepoTags") or []) and \
            labels.get("org.opencontainers.image.revision") == spec["oci_commit"] and \
            labels.get("it.finanzaagevolaimpresa.source-tree") == spec["oci_tree"]

    def ledger(self, pg, deadline):
        # Fixed SQL, using the container's own POSTGRES_USER/DB. No credential or row is logged.
        sql = "SELECT migration_name,checksum,started_at::text,coalesce(finished_at::text,''),coalesce(rolled_back_at::text,''),applied_steps_count::text FROM _prisma_migrations ORDER BY migration_name"
        output = self.run("exec", pg, "sh", "-ceu",
          'exec psql -X -qAt -F "\t" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"',
          "n05-ledger", sql, deadline=deadline)
        rows = [line.split("\t") for line in output.splitlines()]
        require(rows and all(len(row) == 6 and row[0] and row[1] and row[2] and row[3]
                             and not row[4] and row[5] == "1" for row in rows), "LEDGER_INCOMPLETE_FAILED_OR_ROLLED_BACK")
        return {"schema":self.plan["ledger"]["schema"], "count":len(rows), "digest":sha(rows)}

    def snapshot(self, deadline):
        info = json.loads(self.run("info", "--format", "{{json .}}", deadline=deadline))
        actual_engine = {"kind":"docker","host":"unix:///var/run/docker.sock","id":info["ID"],
                         "name":info["Name"],"os_type":info["OSType"]}
        app_ids, pg_ids, migrators = self.ids("app", deadline), self.ids("postgres", deadline), self.ids("migrate", deadline)
        require(len(app_ids) <= 1 and len(pg_ids) == 1, "PROJECT_INVENTORY_INVALID")
        all_ids = self.run("ps", "-aq", "--no-trunc", "--filter", f"label=com.docker.compose.project={self.project}", deadline=deadline).split()
        known = set(app_ids + pg_ids + migrators)
        pg = self.inspect("container", pg_ids[0], deadline)
        require(pg["Id"] == self.plan["postgres"]["id"] and pg["Image"] == self.plan["postgres"]["image"]
                and pg["Created"] == self.plan["postgres"]["created"], "POSTGRES_IDENTITY_DRIFT")
        pg_mounts = pg.get("Mounts") or []
        require(len(pg_mounts) == 1 and pg_mounts[0]["Type"] == "volume" and
                pg_mounts[0]["Name"] == self.project+"_postgres_data" and
                pg_mounts[0]["Destination"] == "/var/lib/postgresql/data" and pg_mounts[0]["RW"],
                "POSTGRES_MOUNT_DRIFT")
        host = pg["HostConfig"]
        require(not host.get("Privileged") and not host.get("CapAdd") and not host.get("Devices") and
                set(pg["NetworkSettings"]["Networks"]) == {self.project+"_default"}, "POSTGRES_RUNTIME_AUTHORITY_DRIFT")
        pg_image = self.inspect("image",pg["Image"],deadline)
        previous_model = strict_json(Path(self.plan["configs"]["previous"]["path"]))
        pg_service = previous_model["services"]["postgres"]
        def env_map(values): return dict(x.split("=",1) for x in values or [])
        expected_env = env_map(pg_image["Config"].get("Env"))
        expected_env.update({k:str(v).replace("$$","$") for k,v in pg_service.get("environment",{}).items()})
        require(env_map(pg["Config"].get("Env")) == expected_env and
                all(pg["Config"].get(k) == pg_image["Config"].get(k) for k in ("Cmd","Entrypoint","User")),
                "POSTGRES_CONFIGURATION_DRIFT")
        volumes = {}
        for logical in ("crm_documents", "postgres_data"):
            raw = self.inspect("volume", self.project + "_" + logical, deadline)
            volumes[logical] = {k:raw[k] for k in ("Name","Driver","Mountpoint","CreatedAt","Labels","Options","Scope")}
        network_raw = self.inspect("network", self.project + "_default", deadline)
        app = None
        if app_ids:
            raw = self.inspect("container", app_ids[0], deadline)
            health = (raw["State"].get("Health") or {}).get("Status")
            state = "healthy" if raw["State"].get("Running") and health == "healthy" else \
                    "running-unhealthy" if raw["State"].get("Running") else "exited"
            tag = raw["Config"]["Image"]
            if raw["Id"] == self.plan["source_app"]["id"]: which = "previous"
            elif raw["Image"] == self.plan["candidate"]["id"]: which = "candidate"
            elif raw["Image"] == self.plan["return_image"]["id"]: which = "return"
            else: raise Denied("APP_IMAGE_NOT_IN_PLAN")
            model_path = Path(self.plan["configs"][which]["path"])
            model = strict_json(model_path)
            module_spec = importlib.util.spec_from_file_location("n05_key_runtime", self.repo/"scripts/n05/key_mounts.py")
            runtime = importlib.util.module_from_spec(module_spec); module_spec.loader.exec_module(runtime)
            image_raw = self.inspect("image", raw["Image"], deadline)
            runtime.validate_runtime(raw, image_raw, model, self.plan["project"], Path("/not-used"), False)
            app = {"id": raw["Id"], "created": raw["Created"], "image_id": raw["Image"],
                   "config_sha256": self.config_digest(which, deadline), "state": state}
        network = {k:network_raw[k] for k in ("Id","Name","Created","Driver","Scope","Labels","Options","IPAM","Internal","Attachable","Ingress")}
        return {"engine": actual_engine, "project": self.project,
          "postgres": {"id": pg["Id"], "image": pg["Image"], "created": pg["Created"]},
          "resources": {"volumes": volumes, "network": network},
          "postgres_healthy": pg["State"].get("Running") and (pg["State"].get("Health") or {}).get("Status") == "healthy",
          "migrators": migrators, "foreign_containers": sorted(set(all_ids)-known),
          "ledger": self.ledger(pg_ids[0], deadline), "app": app}

    def attempted(self, run): return self._attempt
    def mark_attempt(self, run): self._attempt = True

    def recreate_return(self, plan, deadline):
        require(self.config_digest("return", deadline) == plan["configs"]["return"]["sha256"], "RETURN_CONFIG_DRIFT")
        self.validate_boundary(plan, self.snapshot(deadline), deadline, returning=True)
        frozen = plan["configs"]["return"]["path"]
        self.run("compose", "-p", self.project, "--project-directory", str(self.repo),
          "--env-file", str(self.env_file), "-f", frozen, "up", "-d", "--no-deps",
          "--no-build", "--pull", "never", "--force-recreate", "app", deadline=deadline)
        ids = self.ids("app", deadline); require(len(ids) == 1, "RETURN_APP_COUNT_INVALID")
        self.created_callback(ids[0])
        while time.time() < deadline:
            raw = self.inspect("container", ids[0], deadline)
            if raw["State"].get("Running") and (raw["State"].get("Health") or {}).get("Status") == "healthy":
                return ids[0]
            require(raw["State"].get("Running"), "RETURN_APP_EXITED")
            time.sleep(min(1, max(0, deadline-time.time())))
        raise Denied("DEADLINE_EXPIRED")

    def create_candidate(self, plan, deadline):
        require(self.config_digest("candidate", deadline) == plan["configs"]["candidate"]["sha256"], "CANDIDATE_CONFIG_DRIFT")
        if self.synthetic_candidate_absence:
            # Internal drill hook: the forward was interrupted at the explicit create boundary.
            # Production construction cannot select it; absence is still measured with docker ps.
            require(self.observe_app_absence(deadline), "CANDIDATE_ABSENCE_UNCERTAIN")
            return None
        self.run("compose", "-p", self.project, "--project-directory", str(self.repo),
          "--env-file", str(self.env_file), "-f", plan["configs"]["candidate"]["path"], "create", "--no-deps",
          "--no-build", "--pull", "never", "app", deadline=deadline)
        ids = self.ids("app", deadline); require(len(ids) == 1, "CANDIDATE_CREATION_UNOBSERVED")
        self.created_callback(ids[0])
        raw = self.inspect("container", ids[0], deadline)
        return {"id":raw["Id"], "created":raw["Created"], "image_id":raw["Image"]}

    def start_candidate(self, identity, deadline):
        self.run("start", identity, deadline=deadline)
        reason = self.plan["return_reason"]["kind"]
        while time.time() < deadline:
            raw = self.inspect("container",identity,deadline)
            health = (raw["State"].get("Health") or {}).get("Status")
            if ((reason == "functional-failure" and raw["State"].get("Running") and health == "healthy") or
                (reason == "unhealthy" and raw["State"].get("Running") and health == "unhealthy") or
                (reason == "exited" and not raw["State"].get("Running"))):
                return
            time.sleep(min(0.5,max(0,deadline-time.time())))
        raise Denied("CANDIDATE_OBSERVATION_DEADLINE_EXPIRED")

    def remove_source(self, identity, deadline):
        raw = self.inspect("container", identity, deadline)
        require(raw["Id"] == identity, "SOURCE_IDENTITY_DRIFT")
        self.run("rm", "-f", identity, deadline=deadline)

    def observe_app_absence(self, deadline):
        # ps succeeded and returned no app: this is an observation, not an inspect error interpretation.
        return self.ids("app", deadline) == []

    def validate_boundary(self, plan, snapshot, deadline, returning=False):
        require(snapshot["engine"] == plan["engine"] and snapshot["postgres"] == plan["postgres"] and
                snapshot["resources"] == plan["resources"] and snapshot["postgres_healthy"] and
                snapshot["ledger"] == plan["ledger"] and not snapshot["migrators"] and
                not snapshot["foreign_containers"], "MUTATION_BOUNDARY_DRIFT")
        require(self.image(plan["candidate" if not returning else "return_image"], deadline), "BOUNDARY_IMAGE_UNAVAILABLE")
        version = self.run("compose","version","--short",deadline=deadline).strip().lstrip("v")
        match = re.match(r"^(\d+)\.(\d+)\.(\d+)",version)
        require(match and tuple(map(int,match.groups())) >= (2,24,4), "COMPOSE_VERSION_UNSUPPORTED")

    def migrator(self, identity, deadline):
        ids = self.run("ps", "-aq", "--no-trunc", "--filter", "id="+identity, deadline=deadline).split()
        if not ids: return None
        require(ids == [identity], "MIGRATOR_LOOKUP_AMBIGUOUS")
        raw = self.inspect("container", identity, deadline)
        return {"id":raw["Id"], "created":raw["Created"], "image_id":raw["Image"],
                "role":raw["Config"].get("Labels",{}).get("com.docker.compose.service"),
                "project":raw["Config"].get("Labels",{}).get("com.docker.compose.project"),
                "state":raw["State"]["Status"], "exit_code":raw["State"]["ExitCode"]}

    def remove_migrator(self, identity, deadline):
        self.run("rm", identity, deadline=deadline)


def production_main(argv):
    # Reject selectors and wrong host before reading private approval/config or contacting Docker.
    require(len(argv) == 3 and argv[1] in {"forward", "return"}, "USAGE_FORWARD_OR_RETURN_PLAN")
    require(not any(os.environ.get(x) for x in ("DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_FILE",
                                                "COMPOSE_PROFILES", "COMPOSE_ENV_FILES")), "AMBIENT_SELECTOR_DENIED")
    require(os.environ.get("FAI_ENVIRONMENT") == "production" and
            os.environ.get("FAI_ENVIRONMENT_SENTINEL") == "FAI_CRM_PRODUCTION_V1" and
            os.environ.get("COMPOSE_PROJECT_NAME") == "fai-crm", "PRODUCTION_IDENTITY_DENIED")
    require(socket.gethostname() == "fai-crm-prod-02", "PRODUCTION_HOST_IDENTITY_MISMATCH")
    plan_path = Path(argv[2]); private_file(plan_path)
    plan = validate_plan(strict_json(plan_path))
    require(plan["project"] == "fai-crm", "PRODUCTION_PROJECT_DENIED")
    receipt_path = Path(plan["receipt_path"])
    journal_path = Path(plan["journal_path"])
    require(receipt_path.parent == plan_path.parent == journal_path.parent, "PRIVATE_RUN_DIRECTORY_MISMATCH")
    binding = {"run_id":plan["run_id"], "tools_commit":plan["tools"]["commit"],
               "tools_tree":plan["tools"]["tree"], "ci_sha":plan["tools"]["ci_sha"],
               "engine_id":plan["engine"]["id"], "project":plan["project"],
               "return_image_id":plan["return_image"]["id"], "ledger_digest":plan["ledger"]["digest"]}
    for reference in plan["gates"].values(): validate_evidence(reference, plan, binding)
    validate_evidence(plan["compatibility"], plan, binding)
    if plan["return_reason"]["evidence"]:
        validate_evidence(plan["return_reason"]["evidence"], plan, binding)
    for reference in [*plan["configs"].values(), *plan["gates"].values(), plan["compatibility"]]:
        require(Path(reference["path"]).parent == plan_path.parent, "PRIVATE_EVIDENCE_DIRECTORY_MISMATCH")
    repo = Path(__file__).resolve().parents[2]
    require(Path.cwd() == repo, "WORKING_DIRECTORY_INVALID")
    def git(*args):
        status, stdout, _ = run_deadline(["git","-C",str(repo),*args],os.environ.copy(),plan["deadline_epoch"])
        require(status == 0, "TOOLS_GIT_CHECK_FAILED")
        return stdout.strip()
    require(git("branch", "--show-current") == "main" and git("rev-parse", "HEAD") == plan["tools"]["commit"] and
            git("rev-parse", "HEAD^{tree}") == plan["tools"]["tree"] and
            not git("status", "--porcelain=v1", "--untracked-files=no"), "TOOLS_IDENTITY_DRIFT")
    lock_path = Path("/run/lock/fai-crm/n05-failed-app-return.lock")
    fd = acquire_lock(lock_path, {"engine_id":plan["engine"]["id"],"project":plan["project"]})
    try:
        engine = DockerEngine(plan, repo)
        if argv[1] == "forward":
            require(not receipt_path.exists(), "FORWARD_RECEIPT_ALREADY_EXISTS")
            ForwardRecorder(engine).run(plan, receipt_path)
        else:
            private_file(receipt_path)
            receipt = strict_json(receipt_path)
            require(not journal_path.exists(), "RETURN_ALREADY_ATTEMPTED")
            ReturnController(engine).return_app(plan, receipt, journal_path)
    finally:
        os.close(fd)
    print("N05_FAILED_APP_" + argv[1].upper() + "_PASS|run=" + plan["run_id"] +
          "|attempts=1|postgres=unchanged|data=unchanged")


if __name__ == "__main__":
    try:
        production_main(sys.argv)
    except (Denied, OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        code = str(sys.exc_info()[1]) if isinstance(sys.exc_info()[1], Denied) else "SAFE_CHECK_FAILED"
        print("N05_FAILED|code=" + code, file=sys.stderr)
        raise SystemExit(1)
