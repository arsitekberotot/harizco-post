#!/usr/bin/env python3
"""Run REAL pinned JMAP tests with a disposable loopback-only fixture service.

Never attaches to the earlier private/stalwart instance. No host-root changes,
public sockets, relay, DNS or submission writes. Network namespace is mandatory.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request

REPO = Path(__file__).resolve().parents[1]
ROOT = Path.home() / ".local/share/harizco-post/test"
EVIDENCE = REPO / ".hermes/evidence/task5"
VERSION = "0.16.25"
ASSET = "stalwart-x86_64-unknown-linux-gnu.tar.gz"
ARCHIVE_HASH = "8ba9cc0ea2795121df5c1264af41e82353c5a3d6860161c4ab70817906d912d3"
BINARY_HASH = "ff97f92d2fbc09fa35fb0020b6b23d17f42279f85a783392d8a9b9c383ed755f"
BASE = "http://127.0.0.1:18081"
RECOVERY = "http://127.0.0.1:18080"
USING = ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"]


def scoped(path: Path):
    # Lexical containment, never resolve() an untrusted write target.
    if not path.is_absolute() or ".." in path.parts or not any(path.is_relative_to(root) for root in (ROOT, EVIDENCE)):
        raise RuntimeError(f"Unsafe fixture path: outside approved trees: {path}")


@contextmanager
def directory(path: Path, create=False):
    scoped(path)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        # Walk EVERY component, including .local/share/harizco-post parents.
        for name in path.parts[1:]:
            if create:
                try:
                    os.mkdir(name, mode=0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            try:
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                raise RuntimeError(f"Unsafe fixture path: directory component {name} in {path}") from error
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


@contextmanager
def private_file(path: Path, flags, mode=0o600):
    scoped(path)
    with directory(path.parent) as parent:
        try:
            # Never truncate until the opened inode is proven regular/unlinked.
            fd = os.open(path.name, flags | os.O_NOFOLLOW | os.O_NONBLOCK, mode, dir_fd=parent)
        except FileNotFoundError:
            raise
        except OSError as error:
            raise RuntimeError(f"Unsafe fixture path: file {path}") from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError(f"Unsafe fixture path: nonregular or hardlinked file {path}")
        if flags & (os.O_WRONLY | os.O_RDWR):
            os.fchmod(fd, mode)
        yield fd
    finally:
        os.close(fd)


def write_private(path: Path, content: bytes, mode=0o600):
    with private_file(path, os.O_WRONLY | os.O_CREAT, mode) as fd:
        os.ftruncate(fd, 0)
        with os.fdopen(os.dup(fd), "wb") as stream:
            stream.write(content)


def read_private(path: Path):
    with private_file(path, os.O_RDONLY) as fd, os.fdopen(os.dup(fd), "rb") as stream:
        return stream.read()


def save(path: Path, value):
    write_private(path, (json.dumps(value, indent=2) + "\n").encode())


def prepare_tree():
    for path in (ROOT, ROOT / "bin", ROOT / "runs"):
        with directory(path, create=True):
            pass
    try:
        with private_file(ROOT / "bin/stalwart", os.O_RDONLY):
            pass
    except FileNotFoundError:
        pass


def new_directory(path: Path):
    scoped(path)
    with directory(path.parent, create=True) as parent:
        # Exclusive: never reuse a pre-existing run, even after a collision.
        os.mkdir(path.name, mode=0o700, dir_fd=parent)
    with directory(path):
        pass


def request(base, auth, method, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(base, data=data, method=method)
    req.add_header("Authorization", "Basic " + base64.b64encode(auth.encode()).decode())
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # Loopback has no proxies, and redirects cannot receive these credentials.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            raise RuntimeError("Unexpected fixture API redirect")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    with opener.open(req, timeout=5) as response:
        return json.load(response)


def call(auth, method, args):
    data = request(RECOVERY + "/jmap/", auth, "POST", {
        "using": USING, "methodCalls": [[method, args, "fixture"]],
    })
    result = data["methodResponses"][0]
    # Record sanitized errors only; never echo credentials or account payloads.
    if result[0] != method:
        raise RuntimeError(f"{method}: {result[0]} {result[1].get('type')}: {result[1].get('description', '')}")
    body = result[1]
    for field in ("notCreated", "notUpdated", "notDestroyed"):
        if body.get(field):
            errors = {key: {k: v for k, v in value.items() if k in ("type", "description", "properties", "validationErrors")} for key, value in body[field].items()}
            raise RuntimeError(f"{method}: {field}: {json.dumps(errors)}")
    return body


def wait_ready(proc, base, auth):
    for _ in range(120):
        if proc.poll() is not None:
            raise RuntimeError(f"Stalwart exited with {proc.returncode}; see private runtime logs")
        try:
            return request(base + "/jmap/session", auth, "GET")
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            time.sleep(0.25)
    raise RuntimeError("Timed out waiting for isolated Stalwart session")


def stop(proc):
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def verify_binary():
    prepare_tree()
    archive = Path(os.environ.get("STALWART_ARCHIVE", str(REPO / "private/stalwart/downloads/stalwart.tar.gz"))).resolve()
    if not archive.is_file():
        raise RuntimeError(f"Pinned archive missing: {archive}. Download v{VERSION}/{ASSET}; no automatic latest install.")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != ARCHIVE_HASH:
        raise RuntimeError(f"Pinned archive checksum mismatch: {digest}")
    binary = ROOT / "bin/stalwart"

    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        if len(members) != 1 or members[0].name != "stalwart" or not members[0].isfile():
            raise RuntimeError("Unexpected pinned archive layout")
        stream = tar.extractfile(members[0])
        if stream is None:
            raise RuntimeError("Pinned archive binary could not be read")
        content = stream.read()
    if hashlib.sha256(content).hexdigest() != BINARY_HASH:
        raise RuntimeError("Pinned executable checksum mismatch")
    write_private(binary, content, 0o700)
    if subprocess.check_output([str(binary), "--version"], text=True).strip() != VERSION:
        raise RuntimeError("Pinned binary version mismatch")
    save(EVIDENCE / "pin.json", {"tag": f"v{VERSION}", "asset": ASSET, "archiveSha256": digest, "binarySha256": BINARY_HASH, "release": f"https://github.com/stalwartlabs/stalwart/releases/tag/v{VERSION}"})
    return binary


def inside():
    prepare_tree()
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")
    signal.signal(signal.SIGTERM, interrupted)
    host_namespace = os.environ["STALWART_FIXTURE_HOST_NAMESPACE"]
    namespace = os.readlink("/proc/self/ns/net")
    if namespace == host_namespace:
        raise RuntimeError("Network namespace isolation failed; refusing startup")
    subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
    # Host-mounted /sys still reflects the host namespace; query netlink instead.
    interfaces = sorted(link["ifname"] for link in json.loads(subprocess.check_output(["ip", "-j", "link"], text=True)))
    if interfaces != ["lo"]:
        raise RuntimeError(f"Fixture namespace contains non-loopback interfaces: {interfaces}")
    binary = ROOT / "bin/stalwart"
    # Fresh run directories, not deletes/resets of any pre-existing store.
    run = ROOT / "runs" / os.environ["STALWART_FIXTURE_RUN_ID"]
    new_directory(run)
    new_directory(run / "blobs")
    if hashlib.sha256(read_private(binary)).hexdigest() != BINARY_HASH:
        raise RuntimeError("Pinned executable checksum mismatch inside namespace")
    config_path = run / "store.json"
    save(config_path, {"@type": "Sqlite", "path": str(run / "stalwart.sqlite"), "blob": {"@type": "File", "path": str(run / "blobs")}})
    recovery_auth = "fixture-bootstrap:" + secrets.token_urlsafe(32)
    secret = secrets.token_urlsafe(32)
    username = "fixture@harizco.test"
    # Strip ALL ambient Stalwart overrides (especially old recovery credentials).
    env = {**{k: v for k, v in os.environ.items() if not k.startswith("STALWART_")}, "STALWART_PUBLIC_URL": BASE}
    proc = None
    with private_file(run / "stalwart.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND) as fd:
        logfile = os.fdopen(os.dup(fd), "ab")
    try:
        proc = subprocess.Popen([str(binary), "-c", str(config_path)], stdout=logfile, stderr=subprocess.STDOUT,
                                env={**env, "STALWART_RECOVERY_MODE": "true", "STALWART_RECOVERY_ADMIN": recovery_auth, "STALWART_RECOVERY_MODE_PORT": "18080"})
        wait_ready(proc, RECOVERY, recovery_auth)
        recovery_sockets = subprocess.check_output(["ss", "-ltnH"], text=True).splitlines()
        save(EVIDENCE / "recovery-isolation.json", {"fixtureNamespace": namespace, "interfaces": interfaces, "listeners": recovery_sockets, "note": "Recovery binds wildcard only inside the loopback-only namespace; never on the host"})
        call(recovery_auth, "x:NetworkListener/set", {"create": {"fixture-http": {"name": "fixture-http", "protocol": "http", "bind": {"127.0.0.1:18081": True}, "useTls": False}}})
        for method, values in [("x:Http/set", {"enableHsts": False, "usePermissiveCors": False}), ("x:Jmap/set", {}), ("x:DnsResolver/set", {"@type": "System"}), ("x:Authentication/set", {})]:
            call(recovery_auth, method, {"update": {"singleton": values}})
            readback = call(recovery_auth, method.replace("/set", "/get"), {"ids": ["singleton"]})["list"]
            if len(readback) != 1 or any(readback[0].get(k) != v for k, v in values.items()):
                raise RuntimeError(f"{method}: singleton readback mismatch")
        domain = call(recovery_auth, "x:Domain/set", {"create": {"fixture-domain": {"name": "harizco.test", "isEnabled": True, "allowRelaying": False, "allowScimProvisioning": False}}})
        domain_id = domain["created"]["fixture-domain"]["id"]
        domain_readback = call(recovery_auth, "x:Domain/get", {"ids": [domain_id]})["list"][0]
        if domain_readback["name"] != "harizco.test" or domain_readback["allowRelaying"] or domain_readback["allowScimProvisioning"]:
            raise RuntimeError("Fixture domain readback mismatch")
        routes = call(recovery_auth, "x:MtaRoute/get", {})["list"]
        if routes:
            raise RuntimeError("Unexpected outbound routes in fresh fixture store")
        enabled = ["authenticate", "jmapMailboxGet", "jmapMailboxQuery", "jmapMailboxCreate", "jmapMailboxUpdate", "jmapMailboxDestroy", "jmapEmailGet", "jmapEmailQuery", "jmapEmailCreate", "jmapEmailUpdate", "jmapEmailDestroy", "jmapEmailImport", "jmapIdentityGet", "jmapEmailSubmissionGet", "jmapEmailSubmissionQuery", "jmapBlobGet", "jmapBlobUpload", "jmapBlobLookup"]
        call(recovery_auth, "x:Account/set", {"create": {"fixture-user": {"@type": "User", "name": "fixture", "domainId": domain_id, "credentials": {"0": {"@type": "Password", "secret": secret}}, "roles": {"@type": "User"}, "permissions": {"@type": "Replace", "enabledPermissions": {p: True for p in enabled}, "disabledPermissions": {}}}}})
        # Exact readback of configured listener and account privilege boundary.
        listeners = call(recovery_auth, "x:NetworkListener/get", {})["list"]
        if len(listeners) != 1 or listeners[0]["bind"] != {"127.0.0.1:18081": True} or listeners[0]["protocol"] != "http":
            raise RuntimeError("Unexpected configured listener; refusing normal startup")
        accounts = call(recovery_auth, "x:Account/get", {})["list"]
        account = next(a for a in accounts if a["name"] == "fixture")
        if account["roles"] != {"@type": "User"} or account["permissions"]["@type"] != "Replace" or account["permissions"]["enabledPermissions"] != {p: True for p in enabled}:
            raise RuntimeError("Restricted account readback mismatch")
        stop(proc)
        proc = subprocess.Popen([str(binary), "-c", str(config_path)], stdout=logfile, stderr=subprocess.STDOUT, env=env)
        wait_ready(proc, BASE, username + ":" + secret)
        runtime = run / "client.json"
        save(runtime, {"baseUrl": BASE, "username": username, "secret": secret, "namespace": namespace, "version": VERSION})
        sockets = subprocess.check_output(["ss", "-ltnH"], text=True)
        if not sockets.strip() or any("127.0.0.1:18081" not in line for line in sockets.splitlines()):
            raise RuntimeError("Normal fixture process opened an unexpected listener")
        save(EVIDENCE / "isolation.json", {"hostNamespace": host_namespace, "fixtureNamespace": namespace, "interfaces": interfaces, "listeners": sockets.splitlines(), "pid": proc.pid, "privateRunDirectory": str(run), "enabledPermissions": enabled, "submissionWritesAllowed": False, "relayConfigured": False})
        evidence_path = EVIDENCE / "responses.jsonl"
        write_private(evidence_path, b"")
        print(f"REAL Stalwart {VERSION}: isolated fixture ready; credentials private at {runtime}", flush=True)
        result = subprocess.run(["npm", "test", "--", "tests/integration/stalwart-import.test.ts"], cwd=REPO,
                                env={**env, "STALWART_FIXTURE_CONFIG": str(runtime), "STALWART_FIXTURE_EVIDENCE": str(evidence_path)})
        return result.returncode
    finally:
        stop(proc)
        logfile.close()
        save(EVIDENCE / "teardown.json", {"stopped": proc is None or proc.poll() is not None, "pid": proc.pid if proc else None, "procAbsent": proc is None or not Path(f"/proc/{proc.pid}").exists(), "privateRunDirectory": str(run)})
        print("Isolated fixture Stalwart stopped; earlier private/stalwart instance untouched.", flush=True)


def main():
    global EVIDENCE
    os.umask(0o077)
    prepare_tree()
    if sys.argv[1:] == ["--inside"]:
        run_id = os.environ["STALWART_FIXTURE_RUN_ID"]
        if len(run_id) != 16 or any(c not in "0123456789abcdef" for c in run_id):
            raise RuntimeError("Invalid fixture run ID")
        EVIDENCE = EVIDENCE / "runs" / run_id
        with directory(EVIDENCE):
            pass
        return inside()
    if sys.argv[1:]:
        raise RuntimeError("Usage: python3 scripts/stalwart-fixtures.py")
    run_id = secrets.token_hex(8)
    evidence = EVIDENCE / "runs" / run_id
    new_directory(evidence)
    EVIDENCE = evidence
    sources = ["scripts/stalwart-fixtures.py", "tests/integration/stalwart-import.test.ts",
               "tests/integration/test_stalwart_fixtures_fs.py", "tests/helpers/stalwart-crash.mjs",
               "tests/fixtures/mail/plain.eml", "tests/fixtures/mail/multipart.eml", "tests/fixtures/mail/inline-image.eml"]
    manifest = {"runId": run_id, "command": "python3 scripts/stalwart-fixtures.py",
                "startedAtUnix": time.time(), "privateRunDirectory": str(ROOT / "runs" / run_id),
                "sourceSha256": {p: hashlib.sha256((REPO / p).read_bytes()).hexdigest() for p in sources}}
    result = 1
    print(f"Fixture run {run_id}; evidence: {EVIDENCE}", flush=True)
    with private_file(EVIDENCE / "runner.log", os.O_WRONLY | os.O_CREAT | os.O_EXCL) as fd, os.fdopen(os.dup(fd), "w") as log:
        try:
            save(EVIDENCE / "manifest.json", manifest)
            verify_binary()
            env = {**os.environ, "STALWART_FIXTURE_HOST_NAMESPACE": os.readlink("/proc/self/ns/net"), "STALWART_FIXTURE_RUN_ID": run_id}
            # Both client and server live inside this namespace; no host bridge.
            proc = subprocess.Popen(["unshare", "--user", "--map-root-user", "--net", "--", sys.executable, str(Path(__file__).resolve()), "--inside"], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            assert proc.stdout is not None
            for line in proc.stdout:
                log.write(line)
                log.flush()
                print(line, end="", flush=True)
            result = proc.wait()
            return result
        finally:
            log.flush()
            artifacts = ["runner.log", "pin.json", "responses.jsonl", "recovery-isolation.json", "isolation.json", "teardown.json"]
            manifest.update({"finishedAtUnix": time.time(), "exitCode": result,
                             "artifactSha256": {p: hashlib.sha256(read_private(EVIDENCE / p)).hexdigest() for p in artifacts if (EVIDENCE / p).exists()}})
            save(EVIDENCE / "manifest.json", manifest)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        # Do not print payloads/configs or subprocess environments.
        print(f"Stalwart fixture BLOCKER: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
