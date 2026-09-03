"""
Tests for inference/_common.py — the helpers every inference server shares.

`is_server_owned` guards GET /files/{job_id}, which deletes what it serves so
the server-output scratch directory does not grow without bound. That is only
safe for files the server created: in local (same-machine) mode the job's
output_path IS the project asset, and the unconditional delete destroyed the
take and its `.meta.json` sidecar.
"""
import os

import pytest

from _common import SERVER_OUTPUT_DIR, is_server_owned, remap_path, JobStore


class TestIsServerOwned:
    def test_project_asset_is_not_server_owned(self):
        path = "/Users/max/pharaoh-projects/abc-123/scenes/s1/assets/take_01.wav"
        assert is_server_owned(path) is False

    def test_file_under_server_output_is_owned(self):
        assert is_server_owned(str(SERVER_OUTPUT_DIR / "job1" / "output.wav")) is True

    def test_traversal_out_of_server_output_is_not_owned(self):
        escaped = str(SERVER_OUTPUT_DIR / ".." / ".." / "etc" / "passwd")
        assert is_server_owned(escaped) is False

    @pytest.mark.parametrize("value", ["", None])
    def test_empty_is_not_owned(self, value):
        assert is_server_owned(value) is False


class TestRemapPath:
    def test_empty_returns_none_so_caller_uses_server_output(self):
        assert remap_path("") is None
        assert remap_path(None) is None

    def test_without_explicit_root_path_is_unchanged(self, monkeypatch):
        monkeypatch.delenv("PHARAOH_PROJECTS_DIR", raising=False)
        p = "/Users/max/pharaoh-projects/abc/x.wav"
        assert remap_path(p) == p

    def test_explicit_root_rebuilds_from_the_uuid_segment(self, monkeypatch):
        monkeypatch.setenv("PHARAOH_PROJECTS_DIR", "/srv/projects")
        uid = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
        got = remap_path(f"/Users/max/pharaoh-projects/{uid}/scenes/s1/a.wav")
        assert got == f"/srv/projects/{uid}/scenes/s1/a.wav"

    def test_path_without_uuid_is_left_alone(self, monkeypatch):
        monkeypatch.setenv("PHARAOH_PROJECTS_DIR", "/srv/projects")
        assert remap_path("/opt/models/tts/config.json") == "/opt/models/tts/config.json"


class TestJobStore:
    def test_create_update_and_read_back(self):
        store = JobStore()
        job_id = "job-1"
        store.create(job_id, model="qwen3-tts", endpoint="custom_voice", params={})
        assert store.get(job_id)["status"] == "pending"

        store.update(job_id, status="running", progress=0.5)
        job = store.get(job_id)
        assert job["status"] == "running"
        assert job["progress"] == 0.5

    def test_update_of_a_missing_job_is_a_no_op(self):
        store = JobStore()
        store.update("nope", status="running")
        assert store.get("nope") is None

    def test_response_projects_the_client_facing_fields(self):
        store = JobStore()
        store.create("j", model="m", endpoint="e", params={})
        store.update("j", status="complete", output_path="/tmp/a.wav")
        resp = store.response("j")
        assert resp["status"] == "complete"
        assert resp["output_path"] == "/tmp/a.wav"
        assert "params" not in resp

    def test_missing_job_reads_as_none(self):
        assert JobStore().get("nope") is None


class TestSpawnJob:
    """
    asyncio holds only a weak reference to a bare create_task, so a job task can
    be garbage-collected mid-flight and the job silently stops at whatever
    progress it reached. spawn_job keeps a strong reference until it finishes.
    """

    def test_task_survives_gc_and_runs_to_completion(self):
        import asyncio
        import gc

        from _common import spawn_job, _BACKGROUND_TASKS

        async def main():
            done = []

            async def work():
                await asyncio.sleep(0)
                done.append(True)

            spawn_job(work())
            # Drop every local reference and force a collection; a weakly-held
            # task would be reaped here.
            gc.collect()
            await asyncio.sleep(0.05)
            return done

        assert asyncio.run(main()) == [True]
        # Registry drains itself once tasks complete.
        assert len(_BACKGROUND_TASKS) == 0

    def test_inference_lock_serializes_generation(self):
        import asyncio

        import _common

        async def main():
            _common._INFERENCE_LOCK = None  # bind to this loop
            lock = _common.inference_lock()
            overlap = {"max": 0, "cur": 0}

            async def job():
                async with lock:
                    overlap["cur"] += 1
                    overlap["max"] = max(overlap["max"], overlap["cur"])
                    await asyncio.sleep(0.01)
                    overlap["cur"] -= 1

            await asyncio.gather(*(job() for _ in range(5)))
            return overlap["max"]

        assert asyncio.run(main()) == 1, "GPU work must not run concurrently"
