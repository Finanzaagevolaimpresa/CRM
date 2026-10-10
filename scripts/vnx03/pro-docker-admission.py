"""Offline validation of read-only Docker metadata. No Docker or DB transport."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


PART_BYTES = 500 * 1024
PART_COUNT = 32


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


def verify_bake(model, args):
    services = {"harness", "crm", "wordpress"}
    require(re.fullmatch(r"fai-vnx03-[a-z0-9-]+", args.project), "PRO_PROJECT_INVALID")
    require(all(re.fullmatch(r"[0-9a-f]{40}", v) for v in (args.head, args.tree)), "PRO_SOURCE_INVALID")
    require(set(model) == {"group", "target"} and set(model["target"]) == services, "PRO_BUILD_TARGETS_INVALID")
    group = model["group"]
    require(set(group) == {"default"} and set(group["default"]) == {"targets"}
            and sorted(group["default"]["targets"]) == sorted(services), "PRO_BUILD_GROUP_INVALID")
    root = Path(args.repository).resolve()
    package_directory = verify_package_directory(args)
    allowed = {"context", "dockerfile", "args", "labels", "tags", "target", "pull", "output", "secret"}
    for name, target in model["target"].items():
        require(set(target) <= allowed, "PRO_BUILD_UNEXPECTED_OPTION")
        require(Path(target["context"]).resolve() == root, "PRO_BUILD_CONTEXT_INVALID")
        dockerfile = "Dockerfile.wordpress" if name == "wordpress" else "Dockerfile.crm"
        require((root / target["dockerfile"]).resolve() == root / "tests" / "vnx03" / dockerfile,
                "PRO_BUILD_DOCKERFILE_INVALID")
        require(target["tags"] == [args.project + "-" + name + ":" + args.head], "PRO_BUILD_TAG_INVALID")
        require(target["pull"] is True and target["output"] == ["type=docker"], "PRO_BUILD_OUTPUT_INVALID")
        labels = target["labels"]
        require(set(labels) == {"com.docker.compose.project", "com.docker.compose.service", "com.docker.compose.version"}
                and labels["com.docker.compose.project"] == args.project
                and labels["com.docker.compose.service"] == name, "PRO_BUILD_LABELS_INVALID")
        if name == "wordpress":
            require("target" not in target, "PRO_BUILD_STAGE_INVALID")
            require(target["args"] == {"WORDPRESS_IMAGE": args.wordpress_image, "WPFORMS_EDITION": "pro",
                    "WPFORMS_SHA256": args.wpforms_sha, "CONNECTOR_SHA256": args.connector_sha,
                    "WP_CLI_SHA256": args.wp_cli_sha}, "PRO_BUILD_ARGS_INVALID")
            secrets = target.get("secret", [])
            require(isinstance(secrets, list) and len(secrets) == PART_COUNT, "PRO_BUILD_PARTS_INVALID")
            for index, secret in enumerate(secrets):
                prefix = f"id=wpforms_pro_{index:02d},type=file,src="
                require(isinstance(secret, str) and secret.startswith(prefix)
                        and Path(secret[len(prefix):]).resolve() == package_directory / f"{index:02d}",
                        "PRO_BUILD_PART_INVALID")
        else:
            require(target.get("target") == name and "secret" not in target, "PRO_BUILD_STAGE_OR_SECRET_INVALID")
            require(target["args"] == {"SOURCE_COMMIT": args.head, "SOURCE_TREE": args.tree}, "PRO_BUILD_ARGS_INVALID")
    return {"buildModelBound": True, "targets": sorted(services), "output": "local-docker"}


def context_location(args):
    root = Path(args.repository).resolve()
    runtime = Path(args.runtime_directory)
    require(runtime.is_absolute() and runtime.is_dir() and not runtime.is_symlink()
            and runtime.resolve() == runtime.absolute()
            and re.fullmatch(r"fai-vnx03\.[A-Za-z0-9]{6}", runtime.name), "PRO_RUNTIME_DIRECTORY_INVALID")
    require(not runtime.resolve().is_relative_to(root), "PRO_PACKAGE_CONTEXT_INSIDE_REPOSITORY")
    return runtime / "pro-package"


def package_bytes(args):
    package = Path(args.package)
    require(package.is_file() and not package.is_symlink()
            and not package.resolve().is_relative_to(Path(args.repository).resolve()),
            "PRO_PACKAGE_PATH_INVALID")
    require(re.fullmatch(r"[0-9a-f]{64}", args.wpforms_sha), "PRO_PACKAGE_DIGEST_INVALID")
    with package.open("rb") as stream:
        data = stream.read(PART_COUNT * PART_BYTES + 1)
    require(0 < len(data) <= PART_COUNT * PART_BYTES, "PRO_PACKAGE_SIZE_INVALID")
    require(hashlib.sha256(data).hexdigest() == args.wpforms_sha, "PRO_PACKAGE_DIGEST_MISMATCH")
    return data


def stage_package(args):
    # Each secret is bounded by BuildKit's 500 KiB limit. The final ZIP digest
    # binds ordering and every byte; adjacent source files never become inputs.
    target = context_location(args)
    data = package_bytes(args)
    target.mkdir(mode=0o700, exist_ok=False)
    for index in range(PART_COUNT):
        with (target / f"{index:02d}").open("xb") as stream:
            stream.write(data[index * PART_BYTES:(index + 1) * PART_BYTES])
    args.package_directory = str(target)
    verify_package_directory(args)
    return {"packagePartsStaged": True, "parts": PART_COUNT, "partMaxBytes": PART_BYTES,
            "bytes": len(data), "sha256": args.wpforms_sha}


def verify_package_directory(args):
    expected = context_location(args)
    target = Path(args.package_directory)
    require(target.is_absolute() and target.is_dir() and not target.is_symlink()
            and target.resolve() == expected.absolute(), "PRO_PACKAGE_CONTEXT_INVALID")
    require({p.name for p in target.iterdir()} == {f"{i:02d}" for i in range(PART_COUNT)},
            "PRO_PACKAGE_CONTEXT_EXTRA_FILES")
    source = package_bytes(args)
    for index in range(PART_COUNT):
        artifact = target / f"{index:02d}"
        require(artifact.is_file() and not artifact.is_symlink(), "PRO_PACKAGE_CONTEXT_FILE_INVALID")
        with artifact.open("rb") as stream:
            staged = stream.read(PART_BYTES + 1)
        require(staged == source[index * PART_BYTES:(index + 1) * PART_BYTES],
                "PRO_PACKAGE_CONTEXT_BYTES_CHANGED")
    return target.resolve()


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
    bake = sub.add_parser("bake")
    for key in ("model", "project", "repository", "package", "runtime-directory", "package-directory", "head", "tree", "wordpress-image",
                "connector-sha", "wpforms-sha", "wp-cli-sha"):
        bake.add_argument("--" + key, required=True)
    stage = sub.add_parser("stage")
    for key in ("repository", "package", "runtime-directory", "wpforms-sha"):
        stage.add_argument("--" + key, required=True)
    args = parser.parse_args()
    try:
        if args.mode == "builder":
            text = sys.stdin.read(2 * 1024 * 1024 + 1)
            require(len(text) <= 2 * 1024 * 1024, "PRO_METADATA_TOO_LARGE")
            result = verify_builder(text, args.context)
        elif args.mode == "bake":
            result = verify_bake(json.loads(read_bounded(args.model)), args)
        elif args.mode == "stage":
            result = stage_package(args)
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
