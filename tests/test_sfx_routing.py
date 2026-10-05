"""sfx_server engine routing: MOSS by default where installed, named engines honoured."""
import pytest

pytest.importorskip("fastapi")
import sfx_server


@pytest.mark.parametrize("installed,params,engine", [
    (True,  {"model_variant": "auto", "backend": ""}, "moss"),
    (True,  {}, "moss"),
    (False, {"model_variant": "auto", "backend": ""}, "woosh"),
    (True,  {"model_variant": "Woosh-DFlow", "backend": "woosh"}, "woosh"),
    (True,  {"model_variant": "AudioLDM-M-Full", "backend": "audioldm"}, "audioldm"),
    (False, {"model_variant": "MOSS-SFX-v2"}, "moss"),  # asked by name: fails clearly rather than swapping engines
])
def test_engine_choice(monkeypatch, installed, params, engine):
    monkeypatch.setattr(sfx_server, "_moss_installed", lambda: installed)
    got = "audioldm" if sfx_server._is_audioldm_request(params) else "moss" if sfx_server._is_moss_request(params) else "woosh"
    assert got == engine


def test_moss_canvas_is_never_shrunk():
    # The worker must denoise MOSS's full 30 s canvas; shorter canvases produce noise.
    src = open(sfx_server.MOSS_WORKER).read()
    assert "max_inference_seconds=" not in src.split("audio = pipe(")[1].split(")")[0]
