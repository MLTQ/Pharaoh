"""
dissect_server: streamed result bundles and persisted job state.

A 20 h book's bundle is tens of GB; it used to be built in memory, and the
scratch dir was deleted before the client had received it. Job state was
in-memory only, so a restart turned every failure into "unknown job".
"""
import io
import json
import zipfile

import numpy as np
import pytest

srv = pytest.importorskip("dissect_server")
from fastapi.testclient import TestClient  # noqa: E402


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(srv, "JOBS_FILE", tmp_path / "jobs.json")
    return TestClient(srv.app)


def _complete_job(job_id, root):
    srv.jobs.create(job_id, "dissect", "dissect", {})
    srv.jobs.update(job_id, status="complete", output_path=str(root / "manifest.json"))


def test_bundle_streams_every_file_intact(client, tmp_path):
    root = tmp_path / "imp"
    (root / "stems").mkdir(parents=True)
    (root / "manifest.json").write_text('{"ok": true}')
    big = np.random.default_rng(0).integers(0, 255, 9 << 20, dtype=np.uint8).tobytes()  # 9 MB, > one 4 MB block
    (root / "stems" / "dialogue.flac").write_bytes(big)
    _complete_job("j-stream", root)

    r = client.get("/files/j-stream")
    assert r.status_code == 200
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["manifest.json", "stems/dialogue.flac"]
    assert z.read("stems/dialogue.flac") == big
    assert root.exists(), "client-owned (same-machine) import dirs are never deleted"


def test_server_owned_scratch_is_removed_only_after_a_full_send(client, tmp_path, monkeypatch):
    root = tmp_path / "scratch"
    root.mkdir()
    (root / "manifest.json").write_text("{}")
    _complete_job("j-owned", root)
    monkeypatch.setattr(srv, "is_server_owned", lambda p: True)
    assert client.get("/files/j-owned").status_code == 200
    assert not root.exists()


def test_finished_jobs_survive_a_restart(client, tmp_path):
    srv.jobs.create("j-fail", "dissect", "dissect", {})
    srv.jobs.update("j-fail", status="failed", error="boom")
    srv._persist("j-fail")
    srv.jobs.create("j-run", "dissect", "dissect", {})
    srv.jobs.update("j-run", status="running", progress=0.4)
    srv._persist("j-run")

    srv.jobs._jobs.clear()  # "restart"
    srv._restore()
    assert client.get("/jobs/j-fail").json()["error"] == "boom"
    j = client.get("/jobs/j-run").json()
    assert j["status"] == "failed" and "restarted" in j["error"]
    assert json.loads((tmp_path / "jobs.json").read_text())


def test_cuda_faults_are_recognised():
    class AcceleratorError(Exception):
        pass
    assert srv._is_cuda_fault(AcceleratorError("CUDA error: an illegal memory access was encountered"))
    assert not srv._is_cuda_fault(ValueError("source audio is shorter than one second"))
