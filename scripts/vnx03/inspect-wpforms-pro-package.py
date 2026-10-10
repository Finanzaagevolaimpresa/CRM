"""Read-only admission of a locally supplied WPForms Pro ZIP.

This checks bytes, structure and declared version. It neither authenticates the
download source nor qualifies the runtime. Never extract, import or execute PHP.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import zipfile

MAX_ARCHIVE_BYTES = 80 * 1024 * 1024
MAX_TOTAL_BYTES = 256 * 1024 * 1024
MAX_ENTRY_BYTES = 32 * 1024 * 1024
MAX_ENTRIES = 15000
REQUIRED = (
    "wpforms/wpforms.php",
    "wpforms/pro/wpforms-pro.php",
    "wpforms/includes/class-process.php",
)


class Rejected(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def inspect_archive(data, expected_version, expected_sha256):
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){2,3}", expected_version) is not None,
            "PRO_EXPECTED_VERSION_INVALID")
    require(re.fullmatch(r"[a-f0-9]{64}", expected_sha256) is not None,
            "PRO_EXPECTED_DIGEST_INVALID")
    require(0 < len(data) <= MAX_ARCHIVE_BYTES, "PRO_ARCHIVE_SIZE_REJECTED")
    digest = hashlib.sha256(data).hexdigest()
    require(digest == expected_sha256, "PRO_ARCHIVE_DIGEST_MISMATCH")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError, ValueError):
        raise Rejected("PRO_ZIP_INVALID") from None

    with archive:
        entries = archive.infolist()
        require(0 < len(entries) <= MAX_ENTRIES, "PRO_ENTRY_COUNT_REJECTED")
        total = 0
        names = set()
        for item in entries:
            name = item.filename
            require(name == item.orig_filename and "\x00" not in name,
                    "PRO_PATH_REJECTED")
            require("\\" not in name and ":" not in name and not name.startswith("/"),
                    "PRO_PATH_REJECTED")
            components = name.rstrip("/").split("/")
            require(all(p not in ("", ".", "..") for p in components),
                    "PRO_PATH_REJECTED")
            require(components[0] == "wpforms", "PRO_ROOT_REJECTED")
            require(name.casefold() not in names, "PRO_DUPLICATE_PATH_REJECTED")
            names.add(name.casefold())
            mode = item.external_attr >> 16
            require(not stat.S_ISLNK(mode), "PRO_SYMLINK_REJECTED")
            require(stat.S_IFMT(mode) in (0, stat.S_IFREG, stat.S_IFDIR),
                    "PRO_SPECIAL_FILE_REJECTED")
            require(not item.flag_bits & 1, "PRO_ENCRYPTED_ENTRY_REJECTED")
            require(item.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED),
                    "PRO_COMPRESSION_REJECTED")
            require(0 <= item.file_size <= MAX_ENTRY_BYTES, "PRO_ENTRY_SIZE_REJECTED")
            total += item.file_size
            require(total <= MAX_TOTAL_BYTES, "PRO_TOTAL_SIZE_REJECTED")
            require(item.file_size <= max(item.compress_size, 1) * 1000,
                    "PRO_COMPRESSION_RATIO_REJECTED")
            require(PurePosixPath(name).name.lower() not in
                    ("wp-config.php", ".env", "id_rsa", "id_ed25519"),
                    "PRO_PRIVATE_CONFIGURATION_REJECTED")

        exact = {item.filename: item for item in entries}
        require(all(name in exact and not exact[name].is_dir() for name in REQUIRED),
                "PRO_REQUIRED_SOURCE_MISSING")
        require(exact[REQUIRED[0]].file_size <= 65536, "PRO_HEADER_SIZE_REJECTED")
        source_hashes = {}
        main = None
        try:
            # Read in bounded chunks so each entry's CRC is checked, including
            # sources not selected for metadata. Never materialize files on disk.
            for item in entries:
                if item.is_dir():
                    continue
                h = hashlib.sha256()
                count = 0
                header = bytearray() if item.filename == REQUIRED[0] else None
                with archive.open(item, "r") as stream:
                    while chunk := stream.read(1024 * 1024):
                        count += len(chunk)
                        require(count <= item.file_size, "PRO_ENTRY_LENGTH_MISMATCH")
                        h.update(chunk)
                        if header is not None:
                            header.extend(chunk)
                require(count == item.file_size, "PRO_ENTRY_LENGTH_MISMATCH")
                if item.filename in REQUIRED:
                    source_hashes[item.filename] = h.hexdigest()
                if header is not None:
                    main = bytes(header).decode("utf-8-sig", errors="strict")
        except (zipfile.BadZipFile, UnicodeError, RuntimeError, EOFError, OSError, ValueError) as exc:
            if isinstance(exc, Rejected):
                raise
            raise Rejected("PRO_ZIP_CONTENT_INVALID") from None

        fields = {}
        for field in ("Plugin Name", "Version", "Author", "Plugin URI", "License"):
            found = re.findall(r"^\s*\*?\s*" + re.escape(field) + r":\s*([^\r\n]*)",
                               main[:8192], re.MULTILINE)
            require(len(found) == 1, "PRO_HEADER_AMBIGUOUS")
            fields[field] = found[0].strip()
        require(fields["Plugin Name"] == "WPForms" and fields["Author"] == "WPForms",
                "PRO_IDENTITY_REJECTED")
        require(fields["Plugin URI"].rstrip("/") == "https://wpforms.com",
                "PRO_IDENTITY_REJECTED")
        require(fields["Version"] == expected_version, "PRO_VERSION_MISMATCH")
        require("GPL" in fields["License"], "PRO_LICENSE_HEADER_REJECTED")
        return {
            "status": "PACKAGE_BYTES_AND_DECLARED_IDENTITY_VERIFIED",
            "sha256": digest,
            "bytes": len(data),
            "entries": len(entries),
            "uncompressedBytes": total,
            "editionMarker": "pro/wpforms-pro.php present",
            "declaredVersion": fields["Version"],
            "sourceHashes": source_hashes,
            "sourceAuthenticityAttested": False,
            "runtimeQualified": False,
            "filesExtracted": False,
            "codeExecuted": False,
        }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--outside-directory", type=Path)
    args = parser.parse_args(argv)
    try:
        require(args.archive.is_file() and not args.archive.is_symlink(),
                "PRO_INPUT_FILE_REJECTED")
        if args.outside_directory is not None:
            require(not args.archive.resolve().is_relative_to(args.outside_directory.resolve()),
                    "PRO_INPUT_INSIDE_CHECKOUT_REJECTED")
        with args.archive.open("rb") as source:
            data = source.read(MAX_ARCHIVE_BYTES + 1)
        result = inspect_archive(data, args.expected_version, args.expected_sha256)
    except (OSError, Rejected) as exc:
        code = str(exc) if isinstance(exc, Rejected) else "PRO_INPUT_UNAVAILABLE"
        print(json.dumps({"status": "STOP", "code": code, "runtimeQualified": False}))
        return 2
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
