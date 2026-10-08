"""Deterministic confinement tests: never start a server or namespace.

Temporary trees emulate the approved root; the outside sentinel is synthetic.
"""
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("stalwart_fixtures", REPO / "scripts/stalwart-fixtures.py")
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FixtureConfinementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ["TMPDIR"])
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "approved/test"
        self.root.mkdir(parents=True)
        self.outside = self.base / "outside"
        self.outside.mkdir()
        self.sentinel = self.outside / "stalwart"
        self.sentinel.write_bytes(b"outside sentinel must remain unchanged\n")
        self.evidence = self.base / "evidence"
        self.evidence.mkdir()
        for name, value in [("ROOT", self.root), ("EVIDENCE", self.evidence)]:
            guard = patch.object(runner, name, value)
            guard.start()
            self.addCleanup(guard.stop)
        # Version commands are harmless; a real server/namespace is forbidden.
        guard = patch.object(runner.subprocess, "Popen", side_effect=AssertionError("server startup forbidden"))
        guard.start()
        self.addCleanup(guard.stop)
        guard = patch.object(runner.subprocess, "check_output", return_value=runner.VERSION)
        guard.start()
        self.addCleanup(guard.stop)

    def outside_snapshot(self):
        return {str(p.relative_to(self.outside)): (p.read_bytes(), p.stat().st_mode)
                for p in self.outside.rglob("*") if p.is_file()}

    def assert_refuses_unchanged(self, action):
        before = self.outside_snapshot()
        with self.assertRaisesRegex(RuntimeError, "[Uu]nsafe fixture path"):
            action()
        self.assertEqual(self.outside_snapshot(), before)

    def test_bin_directory_symlink_cannot_redirect_binary_write(self):
        (self.root / "bin").symlink_to(self.outside, target_is_directory=True)
        self.assert_refuses_unchanged(runner.verify_binary)

    def test_binary_file_symlink_cannot_overwrite_outside_sentinel(self):
        (self.root / "bin").mkdir()
        (self.root / "bin/stalwart").symlink_to(self.sentinel)
        self.assert_refuses_unchanged(runner.verify_binary)

    def test_ancestor_namespace_symlink_is_rejected(self):
        (self.outside / "test/bin").mkdir(parents=True)
        (self.outside / "test/bin/stalwart").write_bytes(b"ancestor sentinel\n")
        alias = self.base / "namespace-alias"
        alias.symlink_to(self.outside, target_is_directory=True)
        with patch.object(runner, "ROOT", alias / "test"):
            self.assert_refuses_unchanged(runner.verify_binary)

    def test_runs_symlink_is_rejected_before_server_start(self):
        (self.root / "runs").symlink_to(self.outside, target_is_directory=True)
        with patch.dict(os.environ, {"STALWART_FIXTURE_HOST_NAMESPACE": "different-from-fixture"}), \
                patch.object(runner.subprocess, "run"), \
                patch.object(runner.subprocess, "check_output", return_value='[{"ifname":"lo"}]'):
            self.assert_refuses_unchanged(runner.inside)

    def test_private_config_file_symlinks_cannot_overwrite_sentinel(self):
        run = self.root / "runs/example"
        run.mkdir(parents=True)
        for name in ["store.json", "client.json"]:
            with self.subTest(name=name):
                path = run / name
                path.symlink_to(self.sentinel)
                self.assert_refuses_unchanged(lambda: runner.save(path, {"fixture": True}))

    def test_config_parent_symlink_is_rejected(self):
        (self.root / "runs").symlink_to(self.outside, target_is_directory=True)
        self.assert_refuses_unchanged(lambda: runner.save(self.root / "runs/stalwart", {"fixture": True}))

    def test_hardlinked_file_cannot_overwrite_outside_sentinel(self):
        path = self.root / "client.json"
        os.link(self.sentinel, path)
        self.assert_refuses_unchanged(lambda: runner.save(path, {"fixture": True}))

    def test_each_run_retains_its_own_evidence_and_source_manifest(self):
        with patch.object(runner.sys, "argv", ["stalwart-fixtures.py"]), \
                patch.object(runner.subprocess, "call", return_value=0), \
                patch.object(runner.subprocess, "Popen", side_effect=lambda *a, **k: SimpleNamespace(stdout=[], wait=lambda: 0)):
            for _ in range(2):
                with patch.object(runner, "EVIDENCE", self.evidence):
                    self.assertEqual(runner.main(), 0)
        manifests = sorted(self.evidence.glob("runs/*/manifest.json"))
        self.assertEqual(len(manifests), 2, "shared evidence must not overwrite previous runs")
        import json
        for path in manifests:
            manifest = json.loads(path.read_text())
            self.assertEqual(manifest["runId"], path.parent.name)
            self.assertEqual(manifest["exitCode"], 0)
            self.assertIn("scripts/stalwart-fixtures.py", manifest["sourceSha256"])
            self.assertTrue((path.parent / "runner.log").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
