import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("renderer", Path(__file__).with_name("render-coolify.py"))
renderer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(renderer)


class RendererTests(unittest.TestCase):
    def test_project_resources_remain_isolated_after_coolify_import(self):
        source = {
            "name": "handoff",
            "services": {"api": {"build": {"context": "/release/backend"}, "image": "handoff-api:test", "networks": {"gateway": None}}},
            "networks": {"gateway": {"name": "handoff_gateway"}, "shared": {"name": "operator_network", "external": True}},
            "volumes": {"definitions": {"name": "handoff_definitions"}, "external": {"name": "operator_volume", "external": True}},
        }
        result = renderer.image_only(source)
        self.assertNotIn("name", result)
        self.assertNotIn("build", result["services"]["api"])
        self.assertEqual(result["services"]["api"]["pull_policy"], "never")
        self.assertNotIn("name", result["networks"]["gateway"])
        self.assertNotIn("name", result["volumes"]["definitions"])
        self.assertEqual(result["networks"]["shared"]["name"], "operator_network")
        self.assertEqual(result["volumes"]["external"]["name"], "operator_volume")
        self.assertEqual(source["networks"]["gateway"]["name"], "handoff_gateway")
        self.assertEqual(json.dumps(result, sort_keys=True), json.dumps(renderer.image_only(source), sort_keys=True))
        self.assertEqual(result, renderer.image_only(result))


if __name__ == "__main__":
    unittest.main()
