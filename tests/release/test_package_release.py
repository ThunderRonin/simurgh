import importlib.util
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("package_release", ROOT / "scripts" / "package-release.py")
package_release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package_release)


VERSION = "0.0.1"


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


class ReleasePackagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "repo"
        self.root.mkdir()
        self._create_fixture()

    def tearDown(self):
        self.temporary.cleanup()

    def _create_fixture(self):
        write_json(self.root / "package.json", {"version": VERSION})
        for name in ("chromium-extension", "grafana-plugin", "vscode-extension", "shared", "workspace", "coordinator"):
            write_json(self.root / "packages" / name / "package.json", {"version": VERSION})

        chromium = self.root / "packages" / "chromium-extension"
        write_json(chromium / "manifest.json", {"version": VERSION})
        write_json(chromium / "manifest.firefox.json", {"version": VERSION})
        for build_dir, script in (("dist", "content.js"), ("dist-firefox", "firefox-bootstrap.js")):
            write_json(chromium / build_dir / "manifest.json", {"version": VERSION})
            (chromium / build_dir / script).parent.mkdir(parents=True, exist_ok=True)
            (chromium / build_dir / script).write_bytes(f"{build_dir} bundle\n".encode())
            for size in (16, 32, 48, 128):
                icon = chromium / build_dir / "icons" / f"simurgh-mark-{size}.png"
                icon.parent.mkdir(parents=True, exist_ok=True)
                icon.write_bytes(f"png-{size}".encode())

        grafana = self.root / "packages" / "grafana-plugin"
        write_json(grafana / "src" / "plugin.json", {"info": {"version": VERSION}})
        write_json(grafana / "dist" / "plugin.json", {"info": {"version": VERSION}})
        (grafana / "dist" / "module.js").write_bytes(b"grafana bundle")
        (grafana / "dist" / "img" / "simurgh-mark.svg").parent.mkdir(parents=True, exist_ok=True)
        (grafana / "dist" / "img" / "simurgh-mark.svg").write_bytes(b"<svg/>")

        vscode = self.root / "packages" / "vscode-extension"
        write_json(vscode / "package.json", {"version": VERSION})
        (vscode / "dist" / "extension.js").parent.mkdir(parents=True, exist_ok=True)
        (vscode / "dist" / "extension.js").write_bytes(b"vscode bundle")
        (vscode / "simurgh-logo.png").write_bytes(b"editor logo")
        (self.root / "LICENSE").write_text("Apache License\n", encoding="utf-8")
        (self.root / "NOTICE").write_text("Simurgh contributors\n", encoding="utf-8")
        (self.root / "THIRD_PARTY_NOTICES.md").write_text("Bundled dependency licenses\n", encoding="utf-8")

        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "Release Test"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "release-test@example.invalid"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "."], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "-qm", "fixture"], cwd=self.root, check=True)

    def test_packages_allowlisted_members_and_ignores_extra_secret_files(self):
        secret = self.root / "packages" / "chromium-extension" / "dist" / "profile-secrets.json"
        secret.write_text('{"token":"not-for-release"}', encoding="utf-8")
        output = package_release.package_release(self.root)
        expected_names = {
            "simurgh-chromium-0.0.1.zip",
            "simurgh-firefox-0.0.1.zip",
            "simurgh-grafana-0.0.1.zip",
            "simurgh-vscode-dev-0.0.1.zip",
            "release-manifest.json",
            "SHA256SUMS",
        }
        self.assertEqual({path.name for path in output.iterdir()}, expected_names)
        for artifact in package_release.ARTIFACTS:
            filename = package_release.ARTIFACTS[artifact]["filename"].format(version=VERSION)
            with zipfile.ZipFile(output / filename) as archive:
                names = set(archive.namelist())
                self.assertEqual(len(names), len(archive.namelist()))
                self.assertNotIn("profile-secrets.json", "\n".join(names))
                self.assertEqual(names, self.expected_members(artifact))
                self.assertIn("LICENSE", names)
                self.assertIn("NOTICE", names)
                self.assertIn("THIRD_PARTY_NOTICES.md", names)
                self.assertIn("README.md", names)

    def expected_members(self, artifact):
        spec = package_release.ARTIFACTS[artifact]
        return {member for _source, member in [*spec["members"], *package_release.COMMON_MEMBERS, ("README", "README.md")]}

    def test_manifest_checksums_and_member_hashes_match_archives(self):
        output = package_release.package_release(self.root)
        manifest = json.loads((output / "release-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["source"]["commit"], subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root, text=True).strip())
        self.assertEqual(manifest["source"]["tree"], subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=self.root, text=True).strip())
        self.assertEqual(manifest["version"], VERSION)
        sums = dict(line.split("  ", 1)[::-1] for line in (output / "SHA256SUMS").read_text().splitlines())
        self.assertEqual(sums["release-manifest.json"], package_release.sha256((output / "release-manifest.json").read_bytes()))
        for artifact in manifest["artifacts"]:
            archive_path = output / artifact["file"]
            self.assertEqual(sums[artifact["file"]], package_release.sha256(archive_path.read_bytes()))
            with zipfile.ZipFile(archive_path) as archive:
                self.assertEqual(set(archive.namelist()), {entry["path"] for entry in artifact["members"]})
                readme = archive.read("README.md").decode("utf-8")
                self.assertIn("tracked source only", readme)
                self.assertIn("not attested as freshly built", readme)
                for entry in artifact["members"]:
                    data = archive.read(entry["path"])
                    self.assertEqual(entry["size"], len(data))
                    self.assertEqual(entry["sha256"], package_release.sha256(data))
        self.assertEqual(manifest["source"]["scope"], "clean tracked checkout only")
        self.assertIn("not attested as freshly built", manifest["source"]["buildOutputProvenance"])
        self.assertIn("rebuild and verify", manifest["source"]["buildOutputProvenance"])

    def test_repeated_packaging_is_byte_deterministic(self):
        output = package_release.package_release(self.root)
        first = {path.name: path.read_bytes() for path in output.iterdir()}
        package_release.package_release(self.root)
        second = {path.name: path.read_bytes() for path in output.iterdir()}
        self.assertEqual(first, second)

    def test_version_mismatch_is_rejected(self):
        write_json(self.root / "packages" / "shared" / "package.json", {"version": "0.0.2"})
        with self.assertRaisesRegex(package_release.PackagingError, "Version mismatch"):
            package_release.validate_versions(self.root)

    def test_built_extension_and_plugin_versions_must_match_source(self):
        write_json(self.root / "packages" / "chromium-extension" / "dist-firefox" / "manifest.json", {"version": "0.0.2"})
        with self.assertRaisesRegex(package_release.PackagingError, "dist-firefox/manifest.json"):
            package_release.validate_versions(self.root)
        write_json(self.root / "packages" / "chromium-extension" / "dist-firefox" / "manifest.json", {"version": VERSION})
        write_json(self.root / "packages" / "grafana-plugin" / "dist" / "plugin.json", {"info": {"version": "0.0.2"}})
        with self.assertRaisesRegex(package_release.PackagingError, "dist/plugin.json"):
            package_release.validate_versions(self.root)

    def test_missing_required_file_is_rejected(self):
        (self.root / "packages" / "chromium-extension" / "dist" / "content.js").unlink()
        with self.assertRaisesRegex(package_release.PackagingError, "missing or not a regular file"):
            package_release.validate_required_files(self.root)

    def test_symlink_required_file_is_rejected(self):
        bundle = self.root / "packages" / "chromium-extension" / "dist" / "content.js"
        bundle.unlink()
        bundle.symlink_to("manifest.json")
        with self.assertRaisesRegex(package_release.PackagingError, "must not be a symlink"):
            package_release.validate_required_files(self.root)

    def test_tracked_worktree_changes_are_rejected(self):
        (self.root / "NOTICE").write_text("changed\n", encoding="utf-8")
        with self.assertRaisesRegex(package_release.PackagingError, "worktree must be clean"):
            package_release.validate_clean_worktree(self.root)


if __name__ == "__main__":
    unittest.main()
