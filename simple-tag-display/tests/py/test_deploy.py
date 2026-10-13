"""
Unit tests for deploy_ignition_module.py (stdlib unittest, no gateway needed).

    python -m unittest discover -s simple-tag-display/tests/py -v

Covers the deploy script's safety checks:
  * .modl verification (jar set, EVERY class Java 17, module.xml version)
  * "restarted since": the module must report a startupTime later than the one recorded
    before the restart; a same-version upgrade whose restart brought the old build back
    must NOT pass.
  * build id (mounted/build-id.txt) must match the jar entries; the pre-restart module
    lookup must fail loudly instead of degrading to "first install".
"""
import datetime
import io
import os
import sys
import tempfile
import unittest
import urllib.error
import zipfile
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
import deploy_ignition_module as d  # noqa: E402


def class_bytes(major):
    return b"\xca\xfe\xba\xbe\x00\x00" + bytes([major >> 8, major & 0xFF]) + b"\x00" * 8


def jar(classes, extra=None):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("META-INF/MANIFEST.MF", b"Manifest-Version: 1.0\r\n")
        for name, major in classes.items():
            z.writestr(name, class_bytes(major))
        z.writestr("mounted/js/a.js", b"x")
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return buf.getvalue()


def with_build_id(jars, version="2.0.0", override=None):
    """Adds mounted/build-id.txt (the correct id, or `override`) to the gateway jar, like the Gradle build."""
    keys = {k: f"{k}-{version}.jar" for k in d.BUILD_ID_JARS}
    if not all(v in jars for v in keys.values()):
        return jars
    bid = override if override is not None else d.compute_build_id({k: jars[v] for k, v in keys.items()})
    g = keys["gateway"]
    src = zipfile.ZipFile(io.BytesIO(jars[g]))
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n in src.namelist():
            z.writestr(n, src.read(n))
        z.writestr(d.BUILD_ID_ENTRY, bid + "\n")
    out = dict(jars)
    out[g] = buf.getvalue()
    return out


def modl(path, version="2.0.0", jars=None, xml_version=None, build_id=True):
    jars = jars if jars is not None else {
        f"common-{version}.jar": jar({"a/A.class": 61}),
        f"designer-{version}.jar": jar({"b/B.class": 61}),
        f"gateway-{version}.jar": jar({"c/C.class": 61, "c/D.class": 61}),
    }
    if build_id:
        jars = with_build_id(jars, version)
    with zipfile.ZipFile(path, "w") as z:
        for name, data in jars.items():
            z.writestr(name, data)
        z.writestr("module.xml", f"<modules><module><version>{xml_version or version}</version></module></modules>")
        z.writestr("signatures.properties", "x=y")


class ModlProblems(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "m.modl")

    def test_good_modl_passes(self):
        modl(self.path)
        self.assertEqual(d.modl_problems(self.path, "2.0.0"), [])

    def test_extra_stale_jar_fails(self):
        modl(self.path)
        with zipfile.ZipFile(self.path, "a") as z:
            z.writestr("gateway-1.1.5.jar", jar({"x/X.class": 61}))
        self.assertTrue(any("unexpected jar" in p for p in d.modl_problems(self.path, "2.0.0")))

    def test_newer_bytecode_in_a_later_class_fails(self):
        # the first class is Java 17, a later one is Java 21: checking only the first class would pass this
        modl(self.path, jars={
            "common-2.0.0.jar": jar({"a/A.class": 61}),
            "designer-2.0.0.jar": jar({"b/B.class": 61}),
            "gateway-2.0.0.jar": jar({"c/A.class": 61, "c/Z.class": 65}),
        })
        problems = d.modl_problems(self.path, "2.0.0")
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("c/Z.class (major 65)", problems[0])
        self.assertIn("highest major 65", problems[0])

    def test_module_xml_version_mismatch_fails(self):
        modl(self.path, xml_version="1.1.5")
        self.assertTrue(any("module.xml" in p for p in d.modl_problems(self.path, "2.0.0")))


class BuildId(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "m.modl")

    def base_jars(self):
        return {
            "common-2.0.0.jar": jar({"a/A.class": 61}, {"schemas/x.json": b"{}"}),
            "designer-2.0.0.jar": jar({"b/B.class": 61}),
            "gateway-2.0.0.jar": jar({"c/C.class": 61, "c/D.class": 61}),
        }

    def test_matching_build_id_passes(self):
        modl(self.path, jars=self.base_jars())
        self.assertEqual(d.modl_problems(self.path, "2.0.0"), [])
        embedded, computed = d.modl_build_ids(self.path, "2.0.0")
        self.assertEqual(embedded, computed)
        self.assertRegex(embedded, r"^[0-9a-f]{64}$")

    def test_missing_build_id_fails(self):
        modl(self.path, build_id=False)
        self.assertTrue(any("build-id.txt" in p for p in d.modl_problems(self.path, "2.0.0")))

    def test_class_changed_after_the_build_fails(self):
        # one class of the gateway jar changed after the build id was stamped
        jars = with_build_id(self.base_jars())
        src = zipfile.ZipFile(io.BytesIO(jars["gateway-2.0.0.jar"]))
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            for n in src.namelist():
                data = src.read(n)
                if n == "c/C.class":
                    data = data[:-1] + b"\x01"
                z.writestr(n, data)
        jars["gateway-2.0.0.jar"] = buf.getvalue()
        modl(self.path, jars=jars, build_id=False)
        problems = d.modl_problems(self.path, "2.0.0")
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("build id mismatch", problems[0])

    def test_any_jar_and_any_entry_kind_changes_the_id(self):
        base = self.base_jars()
        ref = d.compute_build_id({k: base[f"{k}-2.0.0.jar"] for k in d.BUILD_ID_JARS})
        variants = {
            "schema": ("common", jar({"a/A.class": 61}, {"schemas/x.json": b"{ }"})),
            "designer class": ("designer", jar({"b/B.class": 61, "b/New.class": 61})),
            "renamed entry": ("gateway", jar({"c/C.class": 61, "c/E.class": 61})),
        }
        for label, (kind, data) in variants.items():
            j = {k: base[f"{k}-2.0.0.jar"] for k in d.BUILD_ID_JARS}
            j[kind] = data
            self.assertNotEqual(d.compute_build_id(j), ref, label)

    def test_manifest_and_build_id_entry_do_not_change_the_id(self):
        base = self.base_jars()
        j = {k: base[f"{k}-2.0.0.jar"] for k in d.BUILD_ID_JARS}
        ref = d.compute_build_id(j)
        j["gateway"] = jar({"c/C.class": 61, "c/D.class": 61}, {d.BUILD_ID_ENTRY: b"whatever"})
        self.assertEqual(d.compute_build_id(j), ref)


class StrictModuleLookup(unittest.TestCase):
    def test_failed_listing_is_not_first_install(self):
        with mock.patch.object(d, "request", return_value=(500, "boom")):
            self.assertIsNone(d.find_module("http://x", "t", "m", "healthy"))
            with self.assertRaises(d.ListingError):
                d.find_module("http://x", "t", "m", "healthy", strict=True)
            with mock.patch.object(d.time, "sleep"):
                with self.assertRaises(d.StepError) as cm:
                    d.find_module_strict("http://x", "t", "m", "healthy", d.EXIT_INSTALL)
            self.assertEqual(cm.exception.code, d.EXIT_INSTALL)

    def test_network_error_is_strict_too(self):
        with mock.patch.object(d, "request", side_effect=urllib.error.URLError("down")):
            with self.assertRaises(d.ListingError):
                d.find_module("http://x", "t", "m", "healthy", strict=True)

    def test_successful_listing_without_the_module_is_first_install(self):
        with mock.patch.object(d, "request", return_value=(200, {"items": [{"id": "other"}]})):
            self.assertIsNone(d.find_module_strict("http://x", "t", "m", "healthy", d.EXIT_INSTALL))

    def test_transient_failure_is_retried(self):
        item = {"id": "m", "state": "ACTIVE"}
        responses = [(503, ""), (200, {"items": [item]})]
        with mock.patch.object(d, "request", side_effect=responses), mock.patch.object(d.time, "sleep"):
            self.assertEqual(d.find_module_strict("http://x", "t", "m", "healthy", d.EXIT_INSTALL), item)


class RestartedSince(unittest.TestCase):
    BEFORE = "2026-10-08T07:56:05.708132600"

    def test_parse_gateway_timestamp_with_nanoseconds(self):
        self.assertEqual(d.parse_startup(self.BEFORE), datetime.datetime(2026, 10, 8, 7, 56, 5, 708132))
        self.assertEqual(d.parse_startup("2026-10-08T07:56:05"), datetime.datetime(2026, 10, 8, 7, 56, 5))
        self.assertIsNone(d.parse_startup(None))
        self.assertIsNone(d.parse_startup("garbage"))

    def test_same_startup_time_is_not_a_restart(self):
        before = d.parse_startup(self.BEFORE)
        self.assertFalse(d.restarted_since({"startupTime": self.BEFORE}, before))

    def test_later_startup_time_is_a_restart(self):
        before = d.parse_startup(self.BEFORE)
        self.assertTrue(d.restarted_since({"startupTime": "2026-10-08T08:01:00.1"}, before))

    def test_earlier_startup_time_is_not_a_restart(self):
        before = d.parse_startup(self.BEFORE)
        self.assertFalse(d.restarted_since({"startupTime": "2026-10-08T07:00:00"}, before))

    def test_first_install_needs_a_startup_time(self):
        self.assertTrue(d.restarted_since({"startupTime": self.BEFORE}, None))
        self.assertFalse(d.restarted_since({}, None))
        self.assertFalse(d.restarted_since(None, None))


class ModuleServicesUp(unittest.TestCase):
    """A failed startup() leaves the module ACTIVE; the history route tells."""

    def test_module_stopping_means_the_startup_failed(self):
        with mock.patch.object(d, "request", return_value=(503, {"v": 2, "ok": False, "error": {"code": "MODULE_STOPPING"}})):
            self.assertFalse(d.module_services_up("http://gw"))

    def test_any_other_refusal_means_the_services_are_up(self):
        for answer in [(409, {"ok": False, "error": {"code": "PROTOCOL_MISMATCH"}}), (401, {"error": {"code": "NO_TOKEN"}}),
                       (415, "unsupported")]:
            with mock.patch.object(d, "request", return_value=answer):
                self.assertTrue(d.module_services_up("http://gw"), answer)

    def test_a_route_concurrency_503_is_not_a_failed_startup_but_no_answer_is(self):
        with mock.patch.object(d, "request", return_value=(503, "Route concurrency limit reached.")):
            self.assertTrue(d.module_services_up("http://gw"))
        with mock.patch.object(d, "request", side_effect=urllib.error.URLError("down")):
            self.assertFalse(d.module_services_up("http://gw"))


if __name__ == "__main__":
    unittest.main()
