#!/usr/bin/env python3
"""Build small unsigned developer ZIPs from a clean tracked checkout.

The recorded commit and tree identify tracked source only. Ignored build outputs
are hashed as packaged but are not attested as fresh builds from that source;
rebuild and verify them separately before relying on an artifact.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


SEMVER = re.compile(
    r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
    r"(?:-((?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)"
    r"(?:\.(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?"
    r"(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$"
)

ARTIFACTS = {
    "chromium": {
        "filename": "simurgh-chromium-{version}.zip",
        "members": [
            ("packages/chromium-extension/dist/manifest.json", "manifest.json"),
            ("packages/chromium-extension/dist/content.js", "content.js"),
            *[
                (f"packages/chromium-extension/dist/icons/simurgh-mark-{size}.png", f"icons/simurgh-mark-{size}.png")
                for size in (16, 32, 48, 128)
            ],
        ],
        "readme": """# Simurgh Chromium developer build

This unsigned developer build is not a Chrome Web Store release. Extract this ZIP, open `chrome://extensions`, enable Developer mode, and choose **Load unpacked** on the extracted directory. Review and grant only the exact Grafana origin you intend to use.
""",
    },
    "firefox": {
        "filename": "simurgh-firefox-{version}.zip",
        "members": [
            ("packages/chromium-extension/dist-firefox/manifest.json", "manifest.json"),
            ("packages/chromium-extension/dist-firefox/firefox-bootstrap.js", "firefox-bootstrap.js"),
            *[
                (f"packages/chromium-extension/dist-firefox/icons/simurgh-mark-{size}.png", f"icons/simurgh-mark-{size}.png")
                for size in (16, 32, 48, 128)
            ],
        ],
        "readme": """# Simurgh Firefox developer build

This unsigned developer build is not a signed Firefox release. Extract this ZIP, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select the extracted `manifest.json`. Firefox removes temporary add-ons when it restarts. Review and grant only the exact Grafana origin you intend to use.
""",
    },
    "grafana": {
        "filename": "simurgh-grafana-{version}.zip",
        "members": [
            ("packages/grafana-plugin/dist/plugin.json", "simurgh-context-app/plugin.json"),
            ("packages/grafana-plugin/dist/module.js", "simurgh-context-app/module.js"),
            ("packages/grafana-plugin/dist/img/simurgh-mark.svg", "simurgh-context-app/img/simurgh-mark.svg"),
        ],
        "readme": """# Simurgh Grafana developer plugin

This unsigned developer artifact is intended for a pinned Grafana development instance, not production installation. Extract the ZIP so `simurgh-context-app` is a child of the Grafana plugins directory, then configure that exact plugin ID in the instance's unsigned-plugin allow-list and restart Grafana. Do not reuse the local lab allow-list in a customer environment.
""",
    },
    "vscode-dev": {
        "filename": "simurgh-vscode-dev-{version}.zip",
        "members": [
            ("packages/vscode-extension/package.json", "simurgh-vscode-extension/package.json"),
            ("packages/vscode-extension/dist/extension.js", "simurgh-vscode-extension/dist/extension.js"),
            ("packages/vscode-extension/simurgh-logo.png", "simurgh-vscode-extension/simurgh-logo.png"),
        ],
        "readme": """# Simurgh VS Code developer build

This ZIP is an unpacked developer extension, not a VSIX installer. Extract it and use the `simurgh-vscode-extension` directory as the extension development path, for example with `code --extensionDevelopmentPath <extracted>/simurgh-vscode-extension`. It is not published or signed for end users.
""",
    },
}

COMMON_MEMBERS = [
    ("LICENSE", "LICENSE"),
    ("NOTICE", "NOTICE"),
    ("THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"),
]
TRACKED_RELEASE_INPUTS = [
    "package.json",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "packages/chromium-extension/manifest.json",
    "packages/chromium-extension/manifest.firefox.json",
    "packages/grafana-plugin/src/plugin.json",
]
VERSION_SOURCE_FILES = [
    "packages/chromium-extension/manifest.json",
    "packages/chromium-extension/manifest.firefox.json",
    "packages/chromium-extension/dist/manifest.json",
    "packages/chromium-extension/dist-firefox/manifest.json",
    "packages/grafana-plugin/src/plugin.json",
    "packages/grafana-plugin/dist/plugin.json",
]


class PackagingError(Exception):
    """A release input is unsafe or inconsistent."""


def read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise PackagingError(f"Could not read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise PackagingError(f"Expected a JSON object in {path}")
    return value


def required_members() -> list[tuple[str, str]]:
    entries = [member for artifact in ARTIFACTS.values() for member in artifact["members"]]
    return list(dict.fromkeys([*entries, *COMMON_MEMBERS]))


def validate_required_files(root: Path) -> None:
    input_paths = {relative for relative, _member in required_members()}
    input_paths.update(TRACKED_RELEASE_INPUTS)
    input_paths.update(VERSION_SOURCE_FILES)
    input_paths.update(str(path.relative_to(root)) for path in (root / "packages").glob("*/package.json"))
    for relative in sorted(input_paths):
        path = root / relative
        current = root
        for part in Path(relative).parts:
            current = current / part
            if current.is_symlink():
                raise PackagingError(f"Release input must not be a symlink: {relative}")
        if not path.exists() or not path.is_file():
            raise PackagingError(f"Required release input is missing or not a regular file: {relative}")


def validate_versions(root: Path) -> str:
    root_package = read_json(root / "package.json")
    version = root_package.get("version")
    if not isinstance(version, str) or not SEMVER.fullmatch(version):
        raise PackagingError(f"Root package version is not valid semantic version text: {version!r}")

    packages = sorted((root / "packages").glob("*/package.json"))
    if not packages:
        raise PackagingError("No workspace package manifests were found")
    for package in packages:
        package_version = read_json(package).get("version")
        if package_version != version:
            raise PackagingError(f"Version mismatch in {package.relative_to(root)}: {package_version!r} != {version!r}")

    def plugin_version(data: dict) -> str | None:
        info = data.get("info")
        return info.get("version") if isinstance(info, dict) else None

    version_sources = [
        (relative, lambda data: data.get("version")) for relative in VERSION_SOURCE_FILES[:4]
    ] + [
        (relative, plugin_version)
        for relative in VERSION_SOURCE_FILES[4:]
    ]
    for relative, get_version in version_sources:
        found = get_version(read_json(root / relative))
        if found != version:
            raise PackagingError(f"Version mismatch in {relative}: {found!r} != {version!r}")
    return version


def git_value(root: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=root, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        raise PackagingError(f"Git command failed ({' '.join(args)}): {result.stderr.strip()}")
    return result.stdout.strip()


def validate_clean_worktree(root: Path) -> tuple[str, str]:
    git_root = Path(git_value(root, "rev-parse", "--show-toplevel")).resolve()
    if git_root != root.resolve():
        raise PackagingError(f"Run the packager from the repository root, not {root}")
    changes = git_value(root, "status", "--porcelain=v1", "--untracked-files=no")
    if changes:
        raise PackagingError("Tracked Git worktree must be clean before packaging")
    expected_tracked = set(TRACKED_RELEASE_INPUTS)
    expected_tracked.update(str(path.relative_to(root)) for path in (root / "packages").glob("*/package.json"))
    tracked = set(git_value(root, "ls-files", "--", *sorted(expected_tracked)).splitlines())
    missing = sorted(expected_tracked - tracked)
    if missing:
        raise PackagingError(f"Release version and legal inputs must be tracked: {', '.join(missing)}")
    return git_value(root, "rev-parse", "HEAD"), git_value(root, "rev-parse", "HEAD^{tree}")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def zip_info(member: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(member, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o644) << 16
    info.internal_attr = 0
    info.flag_bits = 0
    info.extra = b""
    info.comment = b""
    return info


def readme_for(artifact_name: str, version: str) -> bytes:
    title = ARTIFACTS[artifact_name]["readme"].replace("# Simurgh ", f"# Simurgh {version} ", 1)
    provenance = (
        "\n\nProvenance note: the release manifest's commit and tree identify tracked source only. "
        "Ignored build outputs are hashed as packaged but are not attested as freshly built from that source; "
        "rebuild and verify them separately before relying on an artifact.\n"
    )
    return title.strip().encode("utf-8") + provenance.encode("utf-8")


def write_artifact(root: Path, output: Path, artifact_name: str, version: str) -> dict:
    artifact = ARTIFACTS[artifact_name]
    filename = artifact["filename"].format(version=version)
    member_entries = [*artifact["members"], *COMMON_MEMBERS, ("<generated README>", "README.md")]
    file_data: list[tuple[str, bytes]] = []
    for source, member in member_entries:
        data = readme_for(artifact_name, version) if source == "<generated README>" else (root / source).read_bytes()
        file_data.append((member, data))

    target = output / filename
    with zipfile.ZipFile(target, "w") as archive:
        for member, data in file_data:
            archive.writestr(zip_info(member), data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
    members = [{"path": member, "size": len(data), "sha256": sha256(data)} for member, data in file_data]
    return {"file": filename, "sha256": sha256(target.read_bytes()), "members": members}


def package_release(root: Path, output: Path | None = None) -> Path:
    root = root.resolve()
    validate_required_files(root)
    version = validate_versions(root)
    commit, tree = validate_clean_worktree(root)
    destination = output if output is not None else root / "work" / "releases" / f"v{version}"
    if destination.is_symlink():
        raise PackagingError(f"Release output directory must not be a symlink: {destination}")
    destination = destination.resolve()
    expected_output = {
        *(artifact["filename"].format(version=version) for artifact in ARTIFACTS.values()),
        "release-manifest.json",
        "SHA256SUMS",
    }
    if destination.exists():
        unexpected = sorted(child.name for child in destination.iterdir() if child.name not in expected_output)
        if unexpected:
            raise PackagingError(f"Release output directory contains unexpected entries: {', '.join(unexpected)}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".simurgh-release-", dir=destination.parent) as stage_name:
        stage = Path(stage_name)
        artifacts = [write_artifact(root, stage, name, version) for name in ARTIFACTS]
        manifest = {
            "schemaVersion": 1,
            "version": version,
            "source": {
                "commit": commit,
                "tree": tree,
                "scope": "clean tracked checkout only",
                "buildOutputProvenance": (
                    "Ignored build outputs are hashed as packaged but are not attested as freshly built from this source; "
                    "rebuild and verify them separately."
                ),
            },
            "artifacts": artifacts,
        }
        manifest_data = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode("utf-8")
        (stage / "release-manifest.json").write_bytes(manifest_data)
        sums = [f"{artifact['sha256']}  {artifact['file']}" for artifact in artifacts]
        sums.append(f"{sha256(manifest_data)}  release-manifest.json")
        (stage / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")

        destination.mkdir(parents=True, exist_ok=True)
        for staged in stage.iterdir():
            os.replace(staged, destination / staged.name)
    return destination


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--output", type=Path, help="Override the default ignored work/releases/vVERSION directory")
    args = parser.parse_args(argv)
    try:
        destination = package_release(args.root, args.output)
    except PackagingError as error:
        print(f"release packaging refused: {error}", file=sys.stderr)
        return 1
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
