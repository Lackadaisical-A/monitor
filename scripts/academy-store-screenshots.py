"""Collect genuine XCTest screenshots, preserving size and removing PNG alpha via JPEG export."""
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys

source, destination = map(Path, sys.argv[1:3])
destination.mkdir(parents=True, exist_ok=True)
expected = {"01-today", "02-students", "03-projects", "04-skills", "05-courses"}
accepted = {(1179, 2556), (1206, 2622)}
collected = {}


def attachments(value):
    if isinstance(value, dict):
        if "exportedFileName" in value and "suggestedHumanReadableName" in value:
            yield value
        for child in value.values():
            yield from attachments(child)
    elif isinstance(value, list):
        for child in value:
            yield from attachments(child)


for attachment in attachments(json.loads((source / "manifest.json").read_text())):
    name = attachment["suggestedHumanReadableName"]
    match = re.search(r"(0[1-5]-(?:today|students|projects|skills|courses))(?=[^a-z]|$)", name)
    if not match or match[1] not in expected or attachment.get("isAssociatedWithFailure"):
        continue
    slug = match[1]
    path = (source / attachment["exportedFileName"]).resolve()
    if not path.is_relative_to(source.resolve()):
        raise ValueError("Attachment path must stay in the export directory")
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"Expected a PNG capture: {slug}")
    dimensions = struct.unpack(">II", data[16:24])
    if dimensions not in accepted:
        raise ValueError(f"Unexpected screenshot dimensions for {slug}: {dimensions}")
    output = destination / (slug + ".jpg")
    subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "100", str(path), "--out", str(output)], check=True, capture_output=True)
    collected[slug] = {"file": output.name, "pixels": dimensions}

if set(collected) != expected:
    raise ValueError(f"Missing screenshots: {sorted(expected - set(collected))}")
(destination / "provenance.json").write_text(json.dumps({
    "sourceCommit": os.environ.get("GITHUB_SHA"),
    "workflowRun": os.environ.get("GITHUB_RUN_ID"),
    "source": "XCTest captures of the native app using fictional demo records",
    "screenshots": [collected[key] for key in sorted(collected)],
    "visuallyReviewed": False,
}, indent=2) + "\n")
print(f"Collected {len(collected)} real app screenshots; visual review is still required.")
