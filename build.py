#!/usr/bin/env python3
"""
RABG build helper.  Run from the repository folder:

    python build.py            (or just double-click build.bat on Windows)

What it does, in order:
  1. Checks that both manifests are valid JSON and have the SAME version.
  2. Copies the shared files from src/firefox to src/chromium
     (content.js, content.css, popup.html/css/js, icons/gold.svg, icons/silver.svg),
     so the two builds can never drift apart.  Edit files in src/firefox only.
  3. Checks that every file the manifests refer to exists.
  4. Creates two flat zips (manifest.json at the zip root, as the stores require):
         dist/rabg-firefox-v<version>.zip
         dist/rabg-chromium-v<version>.zip

Only Python's standard library is used.
"""
import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
FIREFOX = os.path.join(ROOT, "src", "firefox")
CHROMIUM = os.path.join(ROOT, "src", "chromium")
DIST = os.path.join(ROOT, "dist")

# Files that are identical in both builds (source of truth: src/firefox).
SHARED = [
    "content.js",
    "content.css",
    "popup.html",
    "popup.css",
    "popup.js",
    os.path.join("icons", "gold.svg"),
    os.path.join("icons", "silver.svg"),
]


def fail(message):
    print("\nBUILD FAILED: " + message)
    sys.exit(1)


def load_manifest(folder):
    path = os.path.join(folder, "manifest.json")
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001 - we want to show any problem
        fail("%s is not valid JSON (%s)" % (path, e))


def referenced_files(manifest):
    """Every file path a manifest points to."""
    files = set()
    for size, path in (manifest.get("icons") or {}).items():
        files.add(path)
    action = manifest.get("action") or {}
    if action.get("default_popup"):
        files.add(action["default_popup"])
    icon = action.get("default_icon")
    if isinstance(icon, dict):
        files.update(icon.values())
    elif isinstance(icon, str):
        files.add(icon)
    for cs in manifest.get("content_scripts") or []:
        files.update(cs.get("js") or [])
        files.update(cs.get("css") or [])
    for war in manifest.get("web_accessible_resources") or []:
        files.update(war.get("resources") or [])
    return sorted(files)


def zip_folder(folder, zip_path):
    """Flat zip: manifest.json at the root, forward slashes inside."""
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _dirs, filenames in os.walk(folder):
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                arc = os.path.relpath(full, folder).replace(os.sep, "/")
                z.write(full, arc)
    return zip_path


def main():
    print("RABG build\n----------")

    ff = load_manifest(FIREFOX)
    cr = load_manifest(CHROMIUM)
    if ff.get("version") != cr.get("version"):
        fail("manifest versions differ: firefox=%s, chromium=%s. Bump BOTH."
             % (ff.get("version"), cr.get("version")))
    version = ff["version"]
    print("Version: %s (both manifests agree)" % version)

    # --- sync shared files firefox -> chromium ---
    changed = []
    for rel in SHARED:
        src = os.path.join(FIREFOX, rel)
        dst = os.path.join(CHROMIUM, rel)
        if not os.path.isfile(src):
            fail("missing source file: src/firefox/" + rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        same = os.path.isfile(dst) and open(src, "rb").read() == open(dst, "rb").read()
        if not same:
            shutil.copyfile(src, dst)
            changed.append(rel.replace(os.sep, "/"))
    if changed:
        print("Copied to src/chromium: " + ", ".join(changed))
    else:
        print("src/chromium was already in sync.")

    # --- check referenced files exist ---
    for label, folder, manifest in (("firefox", FIREFOX, ff), ("chromium", CHROMIUM, cr)):
        for rel in referenced_files(manifest):
            if not os.path.isfile(os.path.join(folder, rel)):
                fail("%s manifest refers to a missing file: %s" % (label, rel))
    print("All files referenced by the manifests exist.")

    # --- optional JavaScript syntax check (only if Node.js is installed) ---
    node = shutil.which("node")
    if node:
        for rel in ("content.js", "popup.js"):
            result = subprocess.run([node, "--check", os.path.join(FIREFOX, rel)],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                fail("syntax error in %s:\n%s" % (rel, result.stderr))
        print("JavaScript syntax check passed (node).")
    else:
        print("(Node.js not found - skipped the JavaScript syntax check.)")

    # --- zips ---
    os.makedirs(DIST, exist_ok=True)
    out = []
    for label, folder in (("firefox", FIREFOX), ("chromium", CHROMIUM)):
        path = os.path.join(DIST, "rabg-%s-v%s.zip" % (label, version))
        zip_folder(folder, path)
        out.append(path)
        print("Created %s  (%d KB)" % (os.path.relpath(path, ROOT), os.path.getsize(path) // 1024))

    print("\nDone. Zips are in the 'dist' folder.")


if __name__ == "__main__":
    main()
