import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

DRIVER = Path(__file__).with_name("run_matrix.py")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class DriverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.artifact = self.root / "artifact.py"
        self.marker = self.root / "launches"
        self._write_artifact()
        bundle = self.root / "bundle"
        bundle.mkdir()
        manifest = bundle / "manifest.json"
        model = bundle / "model.onnx"
        model.write_bytes(b"model")
        manifest.write_text(json.dumps({
            "model": "fixture-model",
            "fingerprint": "fixture-fingerprint",
            "dims": 8,
            "max_tokens": 8,
            "pooling": "mean",
            "quantization": "none",
            "recommended_batch": {"rows": 16, "token_budget": 8192},
            "model_file": {"name": "model.onnx", "sha256": digest(model)},
        }))
        ort = self.root / "libonnxruntime.so"
        ort.write_bytes(b"ort")
        corpus = self.root / "corpus.json"
        corpus.write_bytes(b"corpus")
        self.provenance = self.root / "provenance.json"
        self.provenance.write_text(json.dumps({
            "artifact": {"path": str(self.artifact), "sha256": digest(self.artifact)},
            "bundle": {
                "directory": str(bundle),
                "manifest_path": str(manifest),
                "manifest_sha256": digest(manifest),
                "fingerprint": "fixture-fingerprint",
                "model_path": str(model),
                "model_sha256": digest(model),
            },
            "ort": {"path": str(ort), "version": "test", "sha256": digest(ort)},
            "corpus": {"path": str(corpus), "sha256": digest(corpus)},
            "commit": "deadbeef",
        }))

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_artifact(self, mutate: bool = False) -> None:
        mutation = (
            "p = Path(__file__); p.write_text(p.read_text() + '# drift\\n')"
            if mutate else "pass"
        )
        self.artifact.write_text(
            "#!/usr/bin/env python3\n"
            "import os\n"
            "from pathlib import Path\n"
            "marker = Path(os.environ['TEST_LAUNCH_MARKER'])\n"
            "marker.write_text(marker.read_text() + 'x' if marker.exists() else 'x')\n"
            f"{mutation}\n"
            "print('{\"kind\":\"synapse_perf_summary\"}')\n"
        )
        self.artifact.chmod(0o755)

    def run_driver(self, mode: str, out: Path, *extra: str) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["TEST_LAUNCH_MARKER"] = str(self.marker)
        return subprocess.run(
            [
                sys.executable,
                str(DRIVER),
                mode,
                "--run-dir", str(out),
                "--provenance", str(self.provenance),
                "--blocks", "1",
                "--budgets", "4",
                "--topologies", "b0,t2",
                "--cpu-wrapper", "none",
                "--idle-gap-seconds", "0",
                "--no-co-tenancy",
                *extra,
            ],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )

    def test_dry_run_emits_seeded_complete_abba_schedule(self) -> None:
        first = self.root / "dry-first"
        second = self.root / "dry-second"
        self.assertEqual(self.run_driver("dry-run", first, "--seed", "19").returncode, 0)
        self.assertEqual(self.run_driver("dry-run", second, "--seed", "19").returncode, 0)
        left = json.loads((first / "schedule.json").read_text())
        right = json.loads((second / "schedule.json").read_text())
        self.assertEqual(left, right)
        self.assertEqual({letter["cpu_budget"] for letter in left["letters"]}, {4})
        for group in left["abba_groups"]:
            labels = group["labels"]
            self.assertEqual(labels, list(reversed(labels)))
            self.assertEqual(len(labels), 4)
        first_symbols = [group["labels"][0] for group in left["abba_groups"]]
        self.assertLessEqual(
            abs(
                sum(symbol in ("aa-left", "b0") for symbol in first_symbols)
                - sum(symbol not in ("aa-left", "b0") for symbol in first_symbols)
            ),
            1,
        )
        first_by_construct = {}
        for group in left["abba_groups"]:
            key = (group["construct_id"], group["rate_ratio"])
            first_by_construct.setdefault(key, group)
        self.assertTrue(all(group["comparison"] == "aa" for group in first_by_construct.values()))
        self.assertEqual(json.loads((first / "manifest.json").read_text())["status"], "planned")
        self.assertFalse(self.marker.exists())

    def test_default_matrix_includes_all_budget_constructs(self) -> None:
        spec = importlib.util.spec_from_file_location("synapse_concurrency_driver", DRIVER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        constructs = [
            {"id": "budget-4", "cpu_budget": 4, "cpus": list(range(4)), "co_tenancy": False},
            {"id": "budget-4-co-tenancy", "cpu_budget": 4, "cpus": list(range(4)), "co_tenancy": True},
            {"id": "budget-8", "cpu_budget": 8, "cpus": list(range(8)), "co_tenancy": False},
            {"id": "budget-16", "cpu_budget": 16, "cpus": list(range(16)), "co_tenancy": False},
            {"id": "unrestricted", "cpu_budget": None, "cpus": list(range(32)), "co_tenancy": False},
        ]
        schedule = module.build_schedule(7, 1, constructs, module.parse_csv(module.DEFAULT_TOPOLOGIES))
        self.assertEqual(
            {letter["construct_id"] for letter in schedule["letters"]},
            {construct["id"] for construct in constructs},
        )
        self.assertEqual({letter["rate_ratio"] for letter in schedule["letters"]}, {"1:1", "4:1"})

    def test_hash_drift_aborts_before_next_launch(self) -> None:
        self._write_artifact(mutate=True)
        provenance = json.loads(self.provenance.read_text())
        provenance["artifact"]["sha256"] = digest(self.artifact)
        self.provenance.write_text(json.dumps(provenance))
        out = self.root / "drift"
        result = self.run_driver("execute", out)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.marker.read_text(), "x")
        manifest = json.loads((out / "manifest.json").read_text())
        self.assertEqual(manifest["status"], "aborted-provenance-drift")

    def test_clean_execute_creates_raw_and_integrity_outputs(self) -> None:
        out = self.root / "clean"
        result = self.run_driver("execute", out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((out / "raw").is_dir())
        self.assertTrue(any((out / "raw").iterdir()))
        self.assertTrue((out / "environment.txt").is_file())
        self.assertTrue((out / "SHA256SUMS").read_text().strip())
        self.assertEqual(json.loads((out / "manifest.json").read_text())["status"], "complete")
        self.assertEqual(json.loads((out / "summary.json").read_text())["status"], "complete")

    def test_interrupted_resume_allocates_new_slots(self) -> None:
        out = self.root / "resume"
        interrupted = self.run_driver("execute", out, "--max-letters", "1")
        self.assertNotEqual(interrupted.returncode, 0)
        before = json.loads((out / "manifest.json").read_text())
        old_slots = {slot["id"] for slot in before["slots"]}
        self.assertEqual(before["blocks"][0]["status"], "incomplete")

        resumed = self.run_driver("execute", out, "--resume")
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        after = json.loads((out / "manifest.json").read_text())
        new_slots = {slot["id"] for slot in after["slots"]} - old_slots
        self.assertTrue(new_slots)
        self.assertTrue(old_slots.isdisjoint(new_slots))
        self.assertEqual(after["blocks"][-1]["status"], "complete")
        self.assertEqual(after["blocks"][-1]["generation"], 2)


if __name__ == "__main__":
    unittest.main()
