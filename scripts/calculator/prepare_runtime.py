"""Prepare the Windows x64 calculator runtime; no pip or system installs.
Run with any host Python 3: python scripts/calculator/prepare_runtime.py
Downloads are pinned and verified. Only SymPy/mpmath runtime code and licenses
are retained; no GUI packages, numpy, dependency tests, or bytecode caches.
"""
from pathlib import Path
import hashlib
import io
import json
import shutil
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2] / "resources" / "clever-calculator"
PYTHON_VERSION = "3.13.12"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_HASH = "76f238f606250c87c6beac75dccd35ee99070a13490555936abb6cb64ecce3d0"
WHEELS = {
    "sympy": ("1.14.0", "e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5"),
    "mpmath": ("1.3.0", "a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c"),
}


def download(url, digest):
    print(f"Downloading {url}", flush=True)
    with urllib.request.urlopen(url, timeout=120) as response:
        data = response.read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"SHA-256 mismatch: {url}")
    return data


def main():
    sources = {"python": {"version": PYTHON_VERSION, "url": PYTHON_URL, "sha256": PYTHON_HASH}}
    # Build in temporary storage so a failed download cannot destroy a usable runtime.
    with tempfile.TemporaryDirectory(prefix="calculator-runtime-") as temporary:
        runtime = Path(temporary) / "python"
        runtime.mkdir()
        with zipfile.ZipFile(io.BytesIO(download(PYTHON_URL, PYTHON_HASH))) as archive:
            archive.extractall(runtime)
        for name, (version, digest) in WHEELS.items():
            with urllib.request.urlopen(f"https://pypi.org/pypi/{name}/{version}/json", timeout=60) as response:
                metadata = json.load(response)
            wheel = next(f for f in metadata["urls"] if f["filename"] == f"{name}-{version}-py3-none-any.whl")
            if wheel["digests"]["sha256"] != digest:
                raise RuntimeError(f"Unexpected PyPI digest: {name}")
            sources[name] = {"version": version, "url": wheel["url"], "sha256": digest}
            with zipfile.ZipFile(io.BytesIO(download(wheel["url"], digest))) as archive:
                for member in archive.infolist():
                    parts = Path(member.filename).parts
                    if any(p in {"tests", "test", "benchmarks", "__pycache__"} for p in parts):
                        continue
                    if member.filename.endswith((".pyc", ".pyo")):
                        continue
                    if parts and (parts[0] == name or parts[0] == f"{name}-{version}.dist-info"):
                        archive.extract(member, runtime / "Lib" / "site-packages")
        # Explicit search paths; keep site disabled so user/site customization cannot run.
        (runtime / "python313._pth").write_text("python313.zip\n.\nLib/site-packages\n", encoding="ascii")
        target = ROOT / "python"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(runtime, target)
    files = {}
    for file in sorted(ROOT.rglob("*")):
        if file.is_file() and file.name != "runtime-manifest.json":
            files[file.relative_to(ROOT).as_posix()] = {"bytes": file.stat().st_size, "sha256": hashlib.sha256(file.read_bytes()).hexdigest()}
    manifest = {"platform": "win32", "arch": "x64", "sources": sources,
                "policy": "Official embedded CPython stdlib plus SymPy/mpmath only; site disabled; dependency tests/benchmarks removed; licenses retained",
                "originalSource": {"project": "CleverCalculator", "license": "not found in original source tree", "authorization": "Owner confirmed ownership of unpublished CleverCalculator and explicitly authorized public release of the integrated sources and binaries on 2026-10-10; no MIT license is assigned to CleverCalculator; third-party licenses and notices remain applicable"},
                "totalBytes": sum(f["bytes"] for f in files.values()), "files": files}
    (ROOT / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {len(files)} files, {manifest['totalBytes']} bytes (excluding manifest)")


if __name__ == "__main__":
    main()
