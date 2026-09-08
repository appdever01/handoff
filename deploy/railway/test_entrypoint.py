import json
import os
from pathlib import Path
import subprocess
import time
import unittest
import uuid

IMAGE = os.environ.get("HANDOFF_RAILWAY_TEST_IMAGE")
ENTRYPOINT = Path(__file__).with_name("entrypoint.sh").resolve()


@unittest.skipUnless(IMAGE, "Set HANDOFF_RAILWAY_TEST_IMAGE to an already-built Node24 image with util-linux")
class RailwayEntrypointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(["docker", "image", "inspect", IMAGE], capture_output=True, text=True, timeout=15)
        if result.returncode:
            raise RuntimeError("An available Docker daemon and prebuilt test image are required: " + result.stderr.strip())

    def setUp(self):
        self.volume = "handoff-railway-test-" + uuid.uuid4().hex
        subprocess.run(["docker", "volume", "create", self.volume], check=True, capture_output=True, timeout=15)
        self.addCleanup(lambda: subprocess.run(["docker", "volume", "rm", "-f", self.volume], check=True, capture_output=True, timeout=15))

    def command(self, mount=True):
        command = ["docker", "run", "--network", "none", "--read-only", "--user", "0:0", "--pids-limit", "64", "--memory", "128m", "--cpus", "0.5", "--entrypoint", "/usr/local/bin/railway-entrypoint", "--mount", f"type=bind,source={ENTRYPOINT},target=/usr/local/bin/railway-entrypoint,readonly"]
        if mount:
            command += ["--mount", f"type=volume,source={self.volume},target=/data"]
        return command

    def run_node(self, script, mount=True, environment=()):
        command = self.command(mount) + ["--rm"]
        for value in environment:
            command += ["-e", value]
        return subprocess.run(command + [IMAGE, "node", "-e", script], capture_output=True, text=True, timeout=20)

    def test_refuses_missing_or_mismatched_persistent_volume(self):
        for mount, environment in [(False, ()), (True, ("DATA_DIR=/tmp",)), (True, ("RAILWAY_VOLUME_MOUNT_PATH=/other",))]:
            result = self.run_node("console.log('application started')", mount, environment)
            self.assertEqual(result.returncode, 78, result.stderr)
            self.assertNotIn("application started", result.stdout)

    def test_initializes_private_volume_then_drops_privileges_and_retains_data(self):
        result = self.run_node("const fs=require('fs');fs.writeFileSync('/data/proof','persisted',{mode:0o600});console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),managed:process.env.HANDOFF_LOCK_MANAGED,directory:fs.statSync('/data').mode&511,file:fs.statSync('/data/proof').mode&511,status:fs.readFileSync('/proc/self/status','utf8')}))")
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual((data["uid"], data["gid"]), (1000, 1000))
        self.assertTrue(all(group == 1000 for group in data["groups"]))
        self.assertEqual(data["managed"], "1")
        self.assertEqual((data["directory"], data["file"]), (0o700, 0o600))
        self.assertIn("NoNewPrivs:\t1", data["status"])
        self.assertIn("CapEff:\t0000000000000000", data["status"])
        retained = self.run_node("console.log(require('fs').readFileSync('/data/proof','utf8'))")
        self.assertEqual(retained.returncode, 0, retained.stderr)
        self.assertEqual(retained.stdout.strip(), "persisted")

    def test_rejects_a_symlinked_runtime_lock(self):
        result = self.run_node("const fs=require('fs');fs.unlinkSync('/data/.runtime.lock');fs.symlinkSync('/tmp/other-lock','/data/.runtime.lock')")
        self.assertEqual(result.returncode, 0, result.stderr)
        rejected = self.run_node("console.log('application started')")
        self.assertEqual(rejected.returncode, 78, rejected.stderr)
        self.assertNotIn("application started", rejected.stdout)

    def test_second_process_is_refused_and_crash_releases_lock(self):
        holder = "handoff-railway-holder-" + uuid.uuid4().hex
        self.addCleanup(lambda: subprocess.run(["docker", "rm", "-f", holder], capture_output=True, timeout=15))
        subprocess.run(self.command() + ["--detach", "--name", holder, IMAGE, "node", "-e", "console.log('LOCK_HELD');setInterval(()=>{},60000)"], check=True, capture_output=True, timeout=15)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            logs = subprocess.run(["docker", "logs", holder], capture_output=True, text=True, timeout=5)
            if "LOCK_HELD" in logs.stdout:
                break
            time.sleep(0.1)
        else:
            self.fail("Lock holder did not start: " + logs.stderr)
        rejected = self.run_node("console.log('application started')")
        self.assertEqual(rejected.returncode, 73, rejected.stderr)
        subprocess.run(["docker", "kill", "--signal", "KILL", holder], check=True, capture_output=True, timeout=10)
        subprocess.run(["docker", "wait", holder], check=True, capture_output=True, timeout=10)
        resumed = self.run_node("console.log('resumed')")
        self.assertEqual(resumed.returncode, 0, resumed.stderr)
        self.assertEqual(resumed.stdout.strip(), "resumed")


if __name__ == "__main__":
    unittest.main()
