"""
Deploy a signed module (.modl) to an Ignition 8.3 gateway through its REST API.

Called by build-and-sign.ps1 -Deploy; can also be run by hand:

    python deploy_ignition_module.py [--module-file build/Tag-Display.modl]
                                     [--gateway-url URL] [--api-token TOKEN] [--config FILE]
                                     [--module-id ID] [--expect-version 2.0.0]
                                     [--no-restart] [--timeout 240] [--print-target]
                                     [--verify-running]

Standard library only (no `requests`).

Configuration lookup (first match wins, per value):
    1. command line (--gateway-url / --api-token / --module-id)
    2. environment  IGNITION_GATEWAY_URL / IGNITION_API_TOKEN
    3. --config FILE
    4. %APPDATA%\\ctg-module\\deploy.json
    5. deploy_config.local.json next to this script (git-ignored)
A config file that exists but cannot be parsed is an error (exit 2): there is no
silent fallback to placeholder values. The API token is never printed. The token
needs permission to manage modules and restart the gateway
(Gateway > Config > Security > API Keys).

Steps (each checked; the exit code tells which one failed):
     3  .modl verification BEFORE anything is sent: exactly one common/designer/
        gateway-<version>.jar, no other jar, every class Java 17 (major 61),
        module.xml <version>, and the build id (mounted/build-id.txt in the gateway
        jar) equals the SHA-256 recomputed here over every entry of the three jars,
        so a .modl changed after the build is refused (same rules as
        build-and-sign.ps1 -VerifyModl; algorithm in gateway/build.gradle.kts)
    10  GET  /data/api/v1/gateway-info                reachability + token
    11  POST /data/api/v1/modules/upload?fileName=Tag-Display-<version>.modl
    12  POST /data/api/v1/modules/certificate|eula     accept the certificate / EULA if needed
    14  POST /data/api/v1/modules/install?moduleId=...  (first install AND upgrade)
    15  POST /data/api/v1/restart-tasks/restart?confirm=true   (unless --no-restart)
    16  GET  /StatusPing until RUNNING (timeout)
    17  after the restart the RUNNING module is not provably THIS build:
          - quarantined, missing, not ACTIVE, or another version, or
          - its startupTime is not later than the startupTime recorded before the
            restart (rebuilds keep the same module version, so the version
            alone cannot tell a fresh start of the new build from the old build
            coming back), or
          - any file under mounted/ in the uploaded .modl's gateway jar differs,
            byte for byte, from what the gateway serves at /res/simpletagdisplay/<file>.
            mounted/build-id.txt is one of those files and hashes EVERY jar entry
            (classes, schemas, resources of common/designer/gateway), so this proves
            the Java is this build too, not only the web resources. Not covered:
            module.xml beyond its <version> (it is generated from build.gradle.kts;
            a wrong hook/scope makes the module fail to start, which (a) catches), and
          - (c) the module's startup() did not complete: its history route still answers
            MODULE_STOPPING (a failing startup is logged and torn down, and Ignition keeps
            listing the module ACTIVE and serving its files, so (a) and (b) pass)
The lookup of the installed module before the install (13) must succeed: if the
module listing fails (HTTP error) the deploy stops with exit 14 instead of silently
treating the gateway as a first install (that would switch off the restart proof).
--verify-running skips 11..16 and runs only 3, 10 and the content proof of 17:
"is the gateway running exactly this .modl?" (exit 0 yes, 17 no).
There is deliberately NO uninstall step. Verified on 8.3.10:
upload + install of a newer version registers "Module Upgraded", and the restart
swaps the file (the old .modl is removed from user-lib/modules). Adding a
DELETE /modules/uninstall (a step of the v1 deploy script) between upload and
install makes the restart "finalize the upgrade" and then start the OLD version
again. Exit code 13 is
therefore unused. The upload uses a versioned file name so the gateway does not
store "Tag-Display (1).modl" duplicates.

Final line on success:  <module id> <version> RUNNING
"""

import argparse
import datetime
import hashlib
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

DEFAULT_MODULE_ID = "com.example.simpletagdisplay.SimpleTagDisplay"
RESOURCE_ALIAS = "simpletagdisplay"        # SimpleTagDisplayModule.URL_ALIAS: mounted/ -> /res/<alias>/
JAVA17_MAJOR = 61
HERE = os.path.dirname(os.path.abspath(__file__))
PLACEHOLDERS = ("", None, "REPLACE_WITH_YOUR_API_TOKEN", "PASTE_YOUR_API_TOKEN_HERE", "my-key:your-api-token-here")

EXIT_GENERAL = 1
EXIT_CONFIG = 2
EXIT_VERIFY = 3       # same code as build-and-sign.ps1's .modl verification
EXIT_REACH = 10
EXIT_UPLOAD = 11
EXIT_CERT = 12
EXIT_UNINSTALL = 13   # reserved (there is no uninstall step)
EXIT_INSTALL = 14
EXIT_RESTART = 15
EXIT_STATUS = 16
EXIT_HEALTH = 17


class StepError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------------------------
def load_json_config(path):
    """Returns the parsed config dict, None when the file does not exist; exits 2 when malformed."""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError("top level is not an object")
        return data
    except Exception as exc:  # noqa: BLE001 - report any parse problem the same way
        print(f"ERROR: deploy configuration {path} is not valid JSON: {exc}", file=sys.stderr)
        sys.exit(EXIT_CONFIG)


def resolve_config(args):
    files = []
    if args.config:
        if not os.path.isfile(args.config):
            print(f"ERROR: --config file not found: {args.config}", file=sys.stderr)
            sys.exit(EXIT_CONFIG)
        files.append(args.config)
    appdata = os.environ.get("APPDATA")
    if appdata:
        files.append(os.path.join(appdata, "ctg-module", "deploy.json"))
    files.append(os.path.join(HERE, "deploy_config.local.json"))
    configs = [c for c in (load_json_config(f) for f in files) if c is not None]

    def pick(cli, env_name, key):
        if cli:
            return cli
        if env_name and os.environ.get(env_name):
            return os.environ[env_name]
        for c in configs:
            if c.get(key) not in PLACEHOLDERS:
                return c.get(key)
        return None

    url = pick(args.gateway_url, "IGNITION_GATEWAY_URL", "gateway_url")
    token = pick(args.api_token, "IGNITION_API_TOKEN", "api_token")
    module_id = pick(args.module_id, None, "module_id") or DEFAULT_MODULE_ID
    if not url or "REPLACE-WITH-YOUR-GATEWAY" in url or "your-gateway-host" in url:
        print("ERROR: no gateway URL configured (--gateway-url, IGNITION_GATEWAY_URL or a deploy config file;"
              " see deploy_config.example.json).", file=sys.stderr)
        sys.exit(EXIT_CONFIG)
    if token in PLACEHOLDERS:
        print("ERROR: no API token configured (--api-token, IGNITION_API_TOKEN or a deploy config file).", file=sys.stderr)
        sys.exit(EXIT_CONFIG)
    return url.rstrip("/"), token, module_id


# ---------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------
def request(base, token, method, path, params=None, body=None, content_type=None, timeout=120, auth=True):
    """Returns (status, parsed JSON or text). Network errors raise URLError."""
    url = base + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    headers = {"Accept": "application/json"}
    if auth:
        headers["X-Ignition-API-Token"] = token
    data = None
    if body is not None:
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
            headers["Content-Type"] = content_type or "application/octet-stream"
        else:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    text = raw.decode("utf-8", errors="replace")
    try:
        return status, json.loads(text)
    except ValueError:
        return status, text


def short(payload):
    s = payload if isinstance(payload, str) else json.dumps(payload)
    return s[:300]


# ---------------------------------------------------------------------------------------------
# Module helpers
# ---------------------------------------------------------------------------------------------
def modl_version(path):
    """<version> from module.xml inside the .modl, or None."""
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("module.xml").decode("utf-8", errors="replace")
        m = re.search(r"<version>\s*([^<\s]+)\s*</version>", xml)
        return m.group(1) if m else None
    except (OSError, KeyError, zipfile.BadZipFile):
        return None


BUILD_ID_ENTRY = "mounted/build-id.txt"
BUILD_ID_JARS = ("common", "designer", "gateway")


def compute_build_id(jar_bytes):
    """SHA-256 hex over the entries of the common/designer/gateway jars (algorithm: gateway/build.gradle.kts).

    jar_bytes: {"common": bytes, "designer": bytes, "gateway": bytes} (the jar files themselves).
    """
    md = hashlib.sha256()
    for kind in BUILD_ID_JARS:
        with zipfile.ZipFile(io.BytesIO(jar_bytes[kind])) as z:
            names = sorted(n for n in z.namelist()
                           if not n.endswith("/") and n != "META-INF/MANIFEST.MF"
                           and not (kind == "gateway" and n == BUILD_ID_ENTRY))
            for n in names:
                data = z.read(n)
                md.update(f"{kind}/{n}".encode("utf-8"))
                md.update(b"\x00")
                md.update(len(data).to_bytes(8, "big"))
                md.update(data)
    return md.hexdigest()


def modl_build_ids(path, version):
    """(build id embedded in the gateway jar or None, build id recomputed from the jars)."""
    with zipfile.ZipFile(path) as z:
        jar_bytes = {k: z.read(f"{k}-{version}.jar") for k in BUILD_ID_JARS}
    with zipfile.ZipFile(io.BytesIO(jar_bytes["gateway"])) as g:
        try:
            embedded = g.read(BUILD_ID_ENTRY).decode("ascii", "replace").strip()
        except KeyError:
            embedded = None
    return embedded, compute_build_id(jar_bytes)


def modl_problems(path, version):
    """.modl verification. Returns a list of problems; empty = OK."""
    problems = []
    expected = [f"common-{version}.jar", f"designer-{version}.jar", f"gateway-{version}.jar"]
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            jars = [n for n in names if n.lower().endswith(".jar")]
            for e in expected:
                n = sum(1 for j in jars if j.rsplit("/", 1)[-1] == e)
                if n != 1:
                    problems.append(f"expected exactly one {e}, found {n}")
            for j in jars:
                if j.rsplit("/", 1)[-1] not in expected:
                    problems.append(f"unexpected jar in .modl: {j}")
            for j in jars:
                if j.rsplit("/", 1)[-1] not in expected:
                    continue
                with zipfile.ZipFile(io.BytesIO(z.read(j))) as inner:
                    classes = [n for n in inner.namelist() if n.endswith(".class")]
                    if not classes:
                        problems.append(f"{j} contains no classes")
                        continue
                    bad, highest = [], 0
                    for c in classes:
                        head = inner.read(c)[:8]
                        if len(head) < 8 or head[:4] != b"\xca\xfe\xba\xbe":
                            bad.append(f"{c} (not a class file)")
                            continue
                        major = head[6] * 256 + head[7]
                        highest = max(highest, major)
                        if major != JAVA17_MAJOR:
                            bad.append(f"{c} (major {major})")
                    if bad:
                        problems.append(f"{j}: {len(bad)} of {len(classes)} classes are not Java 17 bytecode"
                                        f" (highest major {highest}): {', '.join(bad[:5])}")
            if "module.xml" not in names:
                problems.append("module.xml missing")
            else:
                xml = z.read("module.xml").decode("utf-8", errors="replace")
                if not re.search(r"<version>\s*" + re.escape(version) + r"\s*</version>", xml):
                    problems.append(f"module.xml does not declare <version>{version}")
        if not problems:
            embedded, computed = modl_build_ids(path, version)
            if not embedded:
                problems.append(f"gateway-{version}.jar has no {BUILD_ID_ENTRY} (built with an older version of the build script?)")
            elif embedded != computed:
                problems.append(f"build id mismatch: {BUILD_ID_ENTRY} says {embedded[:16]}, the jar entries hash to"
                                f" {computed[:16]} (a jar was changed after the build, or build.gradle.kts and"
                                " this script disagree on the algorithm)")
    except (OSError, zipfile.BadZipFile) as exc:
        problems.append(f"cannot read {path}: {exc}")
    return problems


def modl_resources(path, version):
    """({relative path: bytes} of mounted/ in the gateway jar, resourceVersion or None)."""
    files, resource_version = {}, None
    with zipfile.ZipFile(path) as z:
        with zipfile.ZipFile(io.BytesIO(z.read(f"gateway-{version}.jar"))) as g:
            for n in g.namelist():
                if n.startswith("mounted/") and not n.endswith("/"):
                    files[n[len("mounted/"):]] = g.read(n)
        with zipfile.ZipFile(io.BytesIO(z.read(f"common-{version}.jar"))) as c:
            for n in c.namelist():
                if n.endswith("module-version.properties"):
                    m = re.search(rb"(?m)^resourceVersion\s*=\s*(\S+)", c.read(n))
                    resource_version = m.group(1).decode("ascii", "replace") if m else None
    return files, resource_version


def fetch_bytes(base, rel, timeout=20):
    """GET /res/<alias>/<rel> with a unique query string (the servlet ignores it; no cache can answer)."""
    url = f"{base}/res/{RESOURCE_ALIAS}/{urllib.parse.quote(rel)}?ctgdeploy={time.time_ns()}"
    req = urllib.request.Request(url, method="GET", headers={"Cache-Control": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, b""


HISTORY_ROUTE = "/data/simpletagdisplay/v2/history"


def module_services_up(base, timeout=20):
    """17(c): did the module's startup() complete? A startup that fails is logged and torn down while
    Ignition still lists the module ACTIVE and serves its mounted files, so (a) and (b) cannot see it. The history route
    is mounted by the platform regardless and answers MODULE_STOPPING (503) exactly while the module's services are not
    installed; any other answer (here: a refusal of the empty, token-less probe) means startup() finished."""
    try:
        status, payload = request(base, None, "POST", HISTORY_ROUTE, body={}, timeout=timeout, auth=False)
    except (urllib.error.URLError, OSError, TimeoutError):
        return False
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return not (status == 503 and "MODULE_STOPPING" in text)


def content_mismatches(base, files):
    """Files the gateway serves differently from the .modl (empty list = it serves exactly this build).

    The build id is probed FIRST and alone: it covers every jar entry, so when it differs (or is missing) the other
    files cannot prove anything and are not requested. This keeps the gateway log quiet: every request for a
    mounted file that does not exist makes Ignition log a ResourceLocator ERROR with a stack trace, and the polling
    loops below would otherwise produce one per file every 2 s while an older build is still running.
    """
    id_rel = BUILD_ID_ENTRY.split("/", 1)[1]
    order = ([id_rel] if id_rel in files else []) + sorted(r for r in files if r != id_rel)
    bad = []
    for rel in order:
        expected = files[rel]
        try:
            status, served = fetch_bytes(base, rel)
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            bad.append(f"{rel}: {exc}")
            if rel == id_rel:
                return bad
            continue
        if status != 200:
            bad.append(f"{rel}: HTTP {status}")
        elif served != expected and rel == id_rel:
            bad.append(f"{rel}: the gateway runs build {served.decode('ascii', 'replace').strip()[:16]}, this .modl is"
                       f" build {expected.decode('ascii', 'replace').strip()[:16]} (classes, schemas or resources differ)")
        elif served != expected:
            bad.append(f"{rel}: served {len(served)} bytes sha256 {hashlib.sha256(served).hexdigest()[:12]},"
                       f" .modl has {len(expected)} bytes sha256 {hashlib.sha256(expected).hexdigest()[:12]}")
        if bad and rel == id_rel:
            return bad   # another build runs: comparing the remaining files proves nothing and only adds log noise
    return bad


def parse_startup(value):
    """Gateway-local ISO timestamp of modules/healthy ('2026-10-08T07:56:05.708132600') -> datetime or None."""
    if not value:
        return None
    m = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?", str(value))
    if not m:
        return None
    frac = (m.group(2) or "0")[:6].ljust(6, "0")
    try:
        return datetime.datetime.fromisoformat(f"{m.group(1)}.{frac}")
    except ValueError:
        return None


def restarted_since(item, before):
    """True when the module item's startupTime is later than `before` (a datetime, or None = first install)."""
    started = parse_startup(item.get("startupTime") if item else None)
    if started is None:
        return False
    return before is None or started > before


class ListingError(Exception):
    """The modules listing itself failed (as opposed to: it worked and does not contain the module)."""


def find_module(base, token, module_id, listing, strict=False):
    """The module's item in modules/<listing>, or None when the listing does not contain it.

    strict=True: a failed listing (network error, non-200, unexpected body) raises ListingError instead of
    returning None, so "could not look" is never mistaken for "not installed".
    """
    try:
        status, data = request(base, token, "GET", f"/data/api/v1/modules/{listing}", {"search": module_id})
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        if strict:
            raise ListingError(f"GET modules/{listing}: {exc}")
        return None
    if status != 200 or not isinstance(data, dict) or not isinstance(data.get("items", []), list):
        if strict:
            raise ListingError(f"GET modules/{listing}: HTTP {status} {short(data)}")
        return None
    for item in data.get("items", []):
        if item.get("id") == module_id:
            return item
    return None


def find_module_strict(base, token, module_id, listing, code, attempts=3):
    """find_module(strict=True) with a few retries; StepError(code) when the listing keeps failing."""
    last = None
    for i in range(attempts):
        try:
            return find_module(base, token, module_id, listing, strict=True)
        except ListingError as exc:
            last = exc
            if i + 1 < attempts:
                time.sleep(2)
    raise StepError(code, f"cannot list installed modules ({last}); refusing to continue: without the current"
                          " state the restart proof of step 17 cannot be made")


def gateway_state(base):
    try:
        status, data = request(base, None, "GET", "/StatusPing", timeout=5, auth=False)
    except (urllib.error.URLError, OSError, TimeoutError):
        return "DOWN"
    if status != 200:
        return f"HTTP{status}"
    if isinstance(data, dict):
        return str(data.get("state", "UNKNOWN"))
    return "UNKNOWN"


# ---------------------------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------------------------
def deploy(args, base, token, module_id):
    module_file = os.path.abspath(args.module_file)
    if not os.path.isfile(module_file):
        raise StepError(EXIT_GENERAL, f"module file not found: {module_file}")
    version = args.expect_version or modl_version(module_file)
    if not version:
        raise StepError(EXIT_GENERAL, f"cannot read <version> from module.xml in {module_file}")

    # 3 --------------------------------------------------------------------------------------
    problems = modl_problems(module_file, version)
    if problems:
        raise StepError(EXIT_VERIFY, ".modl verification failed; refusing to deploy:\n  - " + "\n  - ".join(problems))
    files, resource_version = modl_resources(module_file, version)
    build_id = modl_build_ids(module_file, version)[0]
    print(f".modl verification OK: common/designer/gateway-{version}.jar, Java 17 bytecode, module.xml {version},"
          f" build id {build_id[:16]} matches the jar contents; resourceVersion {resource_version},"
          f" {len(files)} mounted files.")

    # 10 -------------------------------------------------------------------------------------
    try:
        status, info = request(base, token, "GET", "/data/api/v1/gateway-info", timeout=20)
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise StepError(EXIT_REACH, f"gateway {base} not reachable: {exc}")
    if status != 200:
        raise StepError(EXIT_REACH, f"gateway-info returned HTTP {status} (wrong or under-privileged API token?)")
    print(f"Gateway {base} reachable.")

    if args.verify_running:
        healthy = find_module_strict(base, token, module_id, "healthy", EXIT_HEALTH)
        if not healthy or healthy.get("state") != "ACTIVE" or str(healthy.get("version", "")).split(" ")[0] != version:
            raise StepError(EXIT_HEALTH, f"module not ACTIVE at version {version}: {short(healthy)}")
        bad = content_mismatches(base, files)
        if bad:
            raise StepError(EXIT_HEALTH, "the gateway is NOT running this .modl (mounted resources differ):\n  - "
                            + "\n  - ".join(bad))
        print(f"Gateway serves all {len(files)} mounted files of this .modl byte for byte, including build id"
              f" {build_id[:16]} (classes + resources of all three jars; resourceVersion {resource_version};"
              f" module started {healthy.get('startupTime')}).")
        return version

    # 11 -------------------------------------------------------------------------------------
    file_name = f"Tag-Display-{version}.modl"
    with open(module_file, "rb") as fh:
        payload = fh.read()
    print(f"Uploading {os.path.basename(module_file)} as {file_name} ({len(payload)} bytes) ...")
    status, up = request(base, token, "POST", "/data/api/v1/modules/upload", {"fileName": file_name}, body=payload)
    if status != 200 or not isinstance(up, dict):
        raise StepError(EXIT_UPLOAD, f"upload failed: HTTP {status} {short(up)}")
    if up.get("moduleId") and up["moduleId"] != module_id:
        raise StepError(EXIT_UPLOAD, f"uploaded file is module {up['moduleId']}, expected {module_id}")

    # 12 -------------------------------------------------------------------------------------
    if up.get("containsCert") and not up.get("certAccepted"):
        status, res = request(base, token, "POST", "/data/api/v1/modules/certificate", {"moduleId": module_id})
        if status not in (200, 409):
            raise StepError(EXIT_CERT, f"accepting the module certificate failed: HTTP {status} {short(res)}")
        print("Module certificate accepted.")
    if up.get("containsEula") and not up.get("licenseAccepted"):
        status, res = request(base, token, "POST", "/data/api/v1/modules/eula", {"moduleId": module_id})
        if status not in (200, 409):
            raise StepError(EXIT_CERT, f"accepting the module EULA failed: HTTP {status} {short(res)}")
        print("Module EULA accepted.")

    # 13 (informational only: no uninstall, see the module docstring) -------------------------
    # Strict: a failed lookup must not degrade to "first install" (that would accept ANY startupTime in 17).
    installed = find_module_strict(base, token, module_id, "healthy", EXIT_INSTALL)
    quarantined = find_module_strict(base, token, module_id, "quarantined", EXIT_INSTALL)
    # Recorded before the restart: step 17 requires a LATER startupTime (gateway clock on both sides).
    startup_before = parse_startup(installed.get("startupTime")) if installed else None
    if installed and installed.get("state") == "ACTIVE" and startup_before is None:
        raise StepError(EXIT_INSTALL, "the installed module is ACTIVE but its startupTime"
                        f" ({installed.get('startupTime')!r}) cannot be read; refusing to continue: step 17 could"
                        " not tell the new build from the old one coming back")
    if installed and installed.get("version"):
        print(f"Currently installed: {installed.get('version')} ({installed.get('state')}); installing {version} as an upgrade.")
    elif quarantined:
        print(f"Module listed as quarantined ({short(quarantined)}); installing {version}.")
    else:
        print("Module not installed yet (first install).")

    # 14 -------------------------------------------------------------------------------------
    status, res = request(base, token, "POST", "/data/api/v1/modules/install", {"moduleId": module_id})
    if status != 200:
        raise StepError(EXIT_INSTALL, f"install failed: HTTP {status} {short(res)}")
    status, pending = request(base, token, "GET", "/data/api/v1/restart-tasks/pending")
    print(f"Install requested; pending restart tasks: {short(pending)}")

    if args.no_restart:
        print("Not restarting (--no-restart): the new version becomes active after the next gateway restart.")
        return version

    # 15 -------------------------------------------------------------------------------------
    status, res = request(base, token, "POST", "/data/api/v1/restart-tasks/restart", {"confirm": "true"})
    if status != 200:
        raise StepError(EXIT_RESTART, f"restart request failed: HTTP {status} {short(res)}")
    print("Gateway restart requested; waiting for it to go down and come back ...")

    # 16 -------------------------------------------------------------------------------------
    deadline = time.time() + args.timeout
    went_down = False
    down_deadline = time.time() + 60
    while time.time() < down_deadline:
        if gateway_state(base) != "RUNNING":
            went_down = True
            break
        time.sleep(1)
    if not went_down:
        print("WARNING: the gateway never reported a non-RUNNING state; checking the module version anyway.")
    state = None
    while time.time() < deadline:
        state = gateway_state(base)
        if state == "RUNNING":
            break
        time.sleep(2)
    if state != "RUNNING":
        raise StepError(EXIT_STATUS, f"gateway not RUNNING after {args.timeout} s (last state {state})")

    # 17 -------------------------------------------------------------------------------------
    # (a) ACTIVE at this version AND started after the restart request (startupTime later than before).
    healthy = None
    while True:
        quarantined = find_module(base, token, module_id, "quarantined")
        if quarantined:
            raise StepError(EXIT_HEALTH, f"module is quarantined: {short(quarantined)}")
        healthy = find_module(base, token, module_id, "healthy")
        if (healthy and str(healthy.get("version", "")).split(" ")[0] == version and healthy.get("state") == "ACTIVE"
                and restarted_since(healthy, startup_before)):
            break
        if time.time() > deadline:
            if healthy and healthy.get("state") == "ACTIVE" and not restarted_since(healthy, startup_before):
                raise StepError(EXIT_HEALTH, f"module ACTIVE but NOT restarted: startupTime {healthy.get('startupTime')}"
                                f" is not later than before the restart ({startup_before}); the gateway may be"
                                " running the previous build")
            raise StepError(EXIT_HEALTH, f"module not ACTIVE at version {version} after the restart: {short(healthy)}")
        time.sleep(2)
    print(f"Module ACTIVE, started {healthy.get('startupTime')} (before the restart: {startup_before or 'not installed'}).")

    # (b) the gateway serves exactly the web resources of the uploaded .modl
    while True:
        bad = content_mismatches(base, files)
        if not bad:
            break
        if time.time() > deadline:
            raise StepError(EXIT_HEALTH, "the restarted gateway is NOT running the uploaded build (mounted resources"
                            " differ):\n  - " + "\n  - ".join(bad))
        time.sleep(2)
    print(f"Gateway serves all {len(files)} mounted files of the uploaded .modl byte for byte, including build id"
          f" {build_id[:16]} (classes + resources of all three jars; resourceVersion {resource_version}).")

    # (c) the module's startup() completed: ACTIVE + served files do not prove it
    while not module_services_up(base):
        if time.time() > deadline:
            raise StepError(EXIT_HEALTH, "module ACTIVE but its startup failed: the history route still answers"
                            " MODULE_STOPPING (see the gateway log for 'Display Template / CTG startup failed')")
        time.sleep(2)
    print("Module services are up (startup completed).")
    return version


def main():
    p = argparse.ArgumentParser(description="Deploy a signed .modl to an Ignition 8.3 gateway (REST API).")
    p.add_argument("--module-file", default=os.path.join(HERE, "build", "Tag-Display.modl"))
    p.add_argument("--gateway-url")
    p.add_argument("--api-token", help="discouraged: ends up in shell history; prefer a config file or IGNITION_API_TOKEN")
    p.add_argument("--config", help="JSON file with gateway_url / api_token / module_id")
    p.add_argument("--module-id")
    p.add_argument("--expect-version", help="module version to verify after the restart (default: from module.xml)")
    p.add_argument("--no-restart", action="store_true")
    p.add_argument("--timeout", type=int, default=240, help="seconds to wait for the restart (default 240)")
    p.add_argument("--print-target", action="store_true", help="print the resolved gateway URL and exit")
    p.add_argument("--verify-running", action="store_true",
                   help="no upload/restart: exit 0 only if the gateway runs exactly this .modl (else 17)")
    args = p.parse_args()

    if args.api_token:
        print("WARNING: --api-token on the command line is stored in your shell history.", file=sys.stderr)
    base, token, module_id = resolve_config(args)
    if args.print_target:
        print(base)
        return 0
    host = urllib.parse.urlparse(base).hostname or ""
    if base.startswith("http://") and host not in ("localhost", "127.0.0.1"):
        print(f"WARNING: {base} is plain HTTP: the API token travels unencrypted.", file=sys.stderr)

    try:
        version = deploy(args, base, token, module_id)
    except StepError as err:
        print(f"ERROR: {err}", file=sys.stderr)
        return err.code
    except Exception as exc:  # noqa: BLE001 - report and map to the general failure code
        print(f"ERROR during deployment: {exc}", file=sys.stderr)
        return EXIT_GENERAL
    state = "INSTALLED (restart pending)" if args.no_restart and not args.verify_running else "RUNNING"
    print(f"{module_id} {version} {state}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
