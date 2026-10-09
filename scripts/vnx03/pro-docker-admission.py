"""Offline validation of read-only Docker metadata. No Docker or DB transport."""

import argparse
import json
from pathlib import Path
import re
import sys


class Rejected(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def verify_builder(text, context):
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", context), "PRO_BUILDER_CONTEXT_INVALID")
    # Buildx inspect has no JSON output on the supported MSI version. Match
    # only top-level fields: nested labels/devices must not count as nodes.
    def fields(name):
        return re.findall(r"^" + name + r":[ \t]*([^\r\n]*)", text, re.MULTILINE)
    require(fields("Name") == [context, context], "PRO_BUILDER_IDENTITY_MISMATCH")
    require(fields("Driver") == ["docker"], "PRO_BUILDER_DRIVER_REJECTED")
    require(fields("Nodes") == [""], "PRO_BUILDER_NODE_COUNT_REJECTED")
    require(fields("Endpoint") == [context], "PRO_BUILDER_ENDPOINT_REJECTED")
    require(fields("Status") == ["running"], "PRO_BUILDER_NOT_RUNNING")
    require(not fields("Error"), "PRO_BUILDER_ERROR")
    return {"builder": context, "driver": "docker", "endpointContext": context}


def verify_resources(model, project, inventories):
    require(re.fullmatch(r"fai-vnx03-[a-z0-9-]+", project), "PRO_PROJECT_INVALID")
    require(model.get("name") == project, "PRO_MODEL_PROJECT_MISMATCH")
    expected = {"volumes": set(), "networks": set(), "containers": set()}
    for kind in ("volumes", "networks"):
        resources = model.get(kind)
        require(isinstance(resources, dict) and resources, "PRO_MODEL_RESOURCES_MISSING")
        for key, resource in resources.items():
            require(isinstance(resource, dict) and not resource.get("external"), "PRO_EXTERNAL_RESOURCE_REJECTED")
            name = resource.get("name")
            require(name == project + "_" + key, "PRO_RESOURCE_NAME_OUTSIDE_PROJECT")
            expected[kind].add(name)
    services = model.get("services")
    require(isinstance(services, dict) and services, "PRO_MODEL_SERVICES_MISSING")
    for key, service in services.items():
        name = service.get("container_name", project + "-" + key + "-1")
        require(name == project + "-" + key + "-1", "PRO_CONTAINER_NAME_OUTSIDE_PROJECT")
        expected["containers"].add(name)
    for kind, names in expected.items():
        # These inventories are complete name lists, not label-filtered lists.
        require(not names.intersection(inventories[kind]), "PRO_EXISTING_" + kind.upper() + "_NAME")
    return {"resourceNamesAbsent": True, "counts": {k: len(v) for k, v in expected.items()}}


def read_bounded(path):
    with Path(path).open("r", encoding="utf-8-sig") as stream:
        text = stream.read(2 * 1024 * 1024 + 1)
    require(len(text) <= 2 * 1024 * 1024, "PRO_METADATA_TOO_LARGE")
    return text


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="mode", required=True)
    builder = sub.add_parser("builder")
    builder.add_argument("--context", required=True)
    resources = sub.add_parser("resources")
    resources.add_argument("--project", required=True)
    resources.add_argument("--model", required=True)
    for kind in ("volumes", "networks", "containers"):
        resources.add_argument("--" + kind, required=True)
    args = parser.parse_args()
    try:
        if args.mode == "builder":
            text = sys.stdin.read(2 * 1024 * 1024 + 1)
            require(len(text) <= 2 * 1024 * 1024, "PRO_METADATA_TOO_LARGE")
            result = verify_builder(text, args.context)
        else:
            inventories = {kind: set(read_bounded(getattr(args, kind)).splitlines())
                           for kind in ("volumes", "networks", "containers")}
            result = verify_resources(json.loads(read_bounded(args.model)), args.project, inventories)
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
        code = str(exc) if isinstance(exc, Rejected) else "PRO_METADATA_INVALID"
        print(json.dumps({"status": "STOP", "code": code}))
        return 2
    print(json.dumps({"status": "PASS", **result}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
