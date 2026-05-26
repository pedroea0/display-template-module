"""
Deploy the signed Simple Tag Display module to an Ignition 8.3 Gateway via HTTP API.

Called automatically from build-and-sign.ps1 as the final step after the
.modl is signed. Can also be invoked manually:
    python deploy_ignition_module.py [--gateway-url URL] [--api-token TOK]
                                     [--module-file PATH] [--module-id ID]
                                     [--skip-uninstall] [--no-restart]

Lifecycle (4 HTTP calls in sequence):
    1. DELETE /data/api/v1/modules/uninstall   ← schedule current version for removal
    2. POST   /data/api/v1/modules/upload      ← upload the new .modl bytes
    3. POST   /data/api/v1/modules/install     ← finalize install
    4. POST   /data/api/v1/restart-tasks/restart  ← gateway restart applies both ops

Each call is authenticated with X-Ignition-API-Token. The token is created in:
    Gateway → Config → Security → API Keys

All defaults below are dev-only. In production, override with CLI flags or env vars.
"""

import argparse
import json
import os
import sys
import time
from typing import Optional

try:
    import requests  # type: ignore
except ImportError:
    print("ERROR: The 'requests' package is required. Install it with:")
    print("  pip install requests")
    sys.exit(1)


# ---- Default config -------------------------------------------------------
#
# These are PLACEHOLDERS. Two ways to supply your real gateway URL + API token:
#
#   1. (Recommended) Copy deploy_config.example.json to deploy_config.local.json
#      and fill in your own values. That file is git-ignored, so each developer
#      / environment can have its own settings without touching committed code.
#
#   2. Pass --gateway-url and --api-token on the command line. CLI flags win
#      over the file, which wins over the placeholders below.
#
# The API token is created in: Gateway → Config → Security → API Keys
# It needs permission to manage modules and restart the gateway.

DEFAULT_GATEWAY_URL = "http://REPLACE-WITH-YOUR-GATEWAY:8088"     # ← override in deploy_config.local.json
DEFAULT_API_TOKEN   = "REPLACE_WITH_YOUR_API_TOKEN"                # ← override in deploy_config.local.json
DEFAULT_MODULE_ID   = "com.example.simpletagdisplay.SimpleTagDisplay"

# Load deploy_config.local.json if it exists next to this script.
_LOCAL_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deploy_config.local.json")
if os.path.isfile(_LOCAL_CONFIG_PATH):
    try:
        with open(_LOCAL_CONFIG_PATH, "r", encoding="utf-8") as _fh:
            _local = json.load(_fh)
        DEFAULT_GATEWAY_URL = _local.get("gateway_url", DEFAULT_GATEWAY_URL)
        DEFAULT_API_TOKEN   = _local.get("api_token",   DEFAULT_API_TOKEN)
        DEFAULT_MODULE_ID   = _local.get("module_id",   DEFAULT_MODULE_ID)
    except Exception as _exc:
        print(f"WARNING: Failed to load {_LOCAL_CONFIG_PATH}: {_exc}", file=sys.stderr)

# Endpoints from Ignition 8.3 /openapi
MODULE_UNINSTALL_PATH = "/data/api/v1/modules/uninstall"   # DELETE, body: {"uninstall": [moduleId]}
MODULE_UPLOAD_PATH = "/data/api/v1/modules/upload"        # POST, query: fileName=..., body: binary .modl
MODULE_INSTALL_PATH = "/data/api/v1/modules/install"      # POST, query: moduleId=...
GATEWAY_RESTART_PATH = "/data/api/v1/restart-tasks/restart"


def _default_module_file() -> str:
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "build", "Tag-Display.modl")


def build_url(base: str, path: str) -> str:
    base = base.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    return base + path


def require(value: Optional[str], name: str) -> str:
    if not value:
        print(f"ERROR: Missing required {name}.", file=sys.stderr)
        sys.exit(1)
    return value


def api_request(method: str, url: str, api_token: str, **kwargs):
    headers = dict(kwargs.pop("headers", {}))
    headers.setdefault("X-Ignition-API-Token", api_token)
    resp = requests.request(method, url, headers=headers, timeout=120, **kwargs)
    if not resp.ok:
        try:
            body = resp.json()
        except Exception:
            body = resp.text
        raise RuntimeError(f"{method} {url} failed: HTTP {resp.status_code} - {body}")
    return resp


def uninstall_module(base_url: str, api_token: str, module_id: str) -> None:
    """
    Schedule module for uninstall on next Gateway restart.
    DELETE /data/api/v1/modules/uninstall, body: {"uninstall": [moduleId]}
    """
    url = build_url(base_url, MODULE_UNINSTALL_PATH)
    payload = {"uninstall": [module_id]}
    print(f"Uninstalling module '{module_id}' (on next restart) via {url} ...")
    api_request("DELETE", url, api_token, json=payload)


def upload_module(base_url: str, api_token: str, module_file: str) -> None:
    """
    Upload .modl to gateway. POST with query fileName=... and body = binary stream.
    """
    url = build_url(base_url, MODULE_UPLOAD_PATH)
    fileName = os.path.basename(module_file)
    print(f"Uploading module file '{module_file}' via {url} (fileName={fileName}) ...")
    with open(module_file, "rb") as fh:
        data = fh.read()
    api_request(
        "POST",
        url,
        api_token,
        params={"fileName": fileName},
        data=data,
        headers={"Content-Type": "application/octet-stream"},
    )


def install_module(base_url: str, api_token: str, module_id: str) -> None:
    """
    Complete installation of the previously uploaded module.
    POST /data/api/v1/modules/install?moduleId=...
    """
    url = build_url(base_url, MODULE_INSTALL_PATH)
    print(f"Installing module '{module_id}' via {url} ...")
    api_request("POST", url, api_token, params={"moduleId": module_id})


def restart_gateway(base_url: str, api_token: str) -> None:
    """
    Request a full Gateway restart.

    Endpoint (from /openapi):
      POST /data/api/v1/restart-tasks/restart?confirm=true
    """
    url = build_url(base_url, GATEWAY_RESTART_PATH)
    print(f"Requesting Gateway restart via {url} ...")
    # confirm must be provided as a boolean query parameter
    api_request("POST", url, api_token, params={"confirm": "true"})
    print("Gateway restart requested. The Gateway will take some time to come back up.")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Deploy signed Ignition module via HTTP API.")
    parser.add_argument("--gateway-url", default=DEFAULT_GATEWAY_URL, help="Gateway base URL")
    parser.add_argument("--api-token", default=DEFAULT_API_TOKEN, help="API token")
    parser.add_argument("--module-file", default=_default_module_file(), help="Path to .modl file")
    parser.add_argument("--module-id", default=DEFAULT_MODULE_ID, help="Module ID to disable/enable")
    parser.add_argument("--no-restart", action="store_true", help="Do not restart the gateway")
    parser.add_argument("--skip-uninstall", action="store_true", help="Skip uninstall step (e.g. first install)")

    args = parser.parse_args(argv)

    base_url = args.gateway_url
    api_token = args.api_token or DEFAULT_API_TOKEN
    module_file = args.module_file or _default_module_file()
    module_id = args.module_id or DEFAULT_MODULE_ID

    if api_token in ("REPLACE_WITH_YOUR_API_TOKEN", "PASTE_YOUR_API_TOKEN_HERE", "", None):
        print("ERROR: No API token configured. Either:", file=sys.stderr)
        print("  1. Copy deploy_config.example.json → deploy_config.local.json next to this script", file=sys.stderr)
        print("     and fill in your own gateway_url and api_token, OR", file=sys.stderr)
        print("  2. Pass --api-token on the command line.", file=sys.stderr)
        return 1

    if "REPLACE-WITH-YOUR-GATEWAY" in base_url:
        print("ERROR: No gateway URL configured. See deploy_config.example.json or pass --gateway-url.", file=sys.stderr)
        return 1

    if not os.path.isfile(module_file):
        print(f"ERROR: Module file not found: {module_file}", file=sys.stderr)
        return 1

    try:
        if module_id and not args.skip_uninstall:
            uninstall_module(base_url, api_token, module_id)
            time.sleep(2.0)

        upload_module(base_url, api_token, module_file)

        if module_id:
            install_module(base_url, api_token, module_id)

        if not args.no_restart:
            restart_gateway(base_url, api_token)

        print("Deployment complete.")
        return 0
    except Exception as exc:
        print(f"ERROR during deployment: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

