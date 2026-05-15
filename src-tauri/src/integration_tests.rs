// End-to-end smoke test for the core project → script → render pipeline.
//
// Bypasses the inference HTTP servers (those need Python + GPU + are tested
// separately) and exercises the pure Rust path that turns a script.csv +
// asset WAVs into a fully-mastered render.wav and final.wav. This is the
// path most likely to silently regress when ffmpeg/filter-graph code is
// touched, and it's where the loudness/ducking/trim/peaks logic lives.
//
// One test, one assertion bundle: if this passes, the user can render a
// scene and an episode end-to-end.

use crate::commands::audio_engine::{render_episode_with_projects_dir, render_scene_with_projects_dir};
use crate::models::{Character, LlmConfig, Project, Scene, SceneStatus, ScriptRow, Storyboard, VoiceAssignment};
use crate::fountain::{parse_document, blocks_to_rows};
use chrono::Utc;
use std::path::{Path, PathBuf};
use uuid::Uuid;

// ── Fixtures ────────────────────────────────────────────────────────────

fn unique_temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pharaoh_integration_{}_{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_sine_wav(path: &Path, hz: u32, duration_seconds: u32) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    let total = spec.sample_rate * duration_seconds;
    for i in 0..total {
        let t = i as f32 / spec.sample_rate as f32;
        let sample = (((t * hz as f32) * std::f32::consts::TAU).sin() * (i16::MAX as f32 * 0.5)) as i16;
        writer.write_sample(sample).unwrap();
    }
    writer.finalize().unwrap();
}

fn make_blank_row() -> ScriptRow {
    ScriptRow {
        scene: String::new(),
        track: String::new(),
        track_type: String::new(),
        character: String::new(),
        prompt: String::new(),
        file: String::new(),
        start_ms: String::new(),
        duration_ms: String::new(),
        r#loop: "false".into(),
        pan: "0".into(),
        gain_db: "0".into(),
        instruct: String::new(),
        fade_in_ms: "50".into(),
        fade_out_ms: "50".into(),
        reverb_send: "0".into(),
        notes: String::new(),
        gain_envelope: String::new(),
    }
}

fn ffmpeg_available() -> bool {
    std::process::Command::new("ffmpeg")
        .arg("-version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ── Test ────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn end_to_end_render_pipeline() {
    if !ffmpeg_available() {
        eprintln!("skipping: ffmpeg not available");
        return;
    }

    let projects_dir = unique_temp_dir();
    let project_id = Uuid::new_v4().to_string();
    let project_root = projects_dir.join(&project_id);
    std::fs::create_dir_all(&project_root).unwrap();

    // ── 1. Project + character ──
    let project = Project {
        id: project_id.clone(),
        title: "Integration Test".into(),
        logline: "verifying the render pipeline end to end".into(),
        synopsis: String::new(),
        tone: String::new(),
        global_audio_notes: String::new(),
        target_duration_minutes: 30,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        characters: vec![Character {
            id: "MIRA".into(),
            name: "Mira".into(),
            description: String::new(),
            voice_assignment: VoiceAssignment {
                model: "VoiceDesign".into(),
                speaker: None,
                instruct_default: None,
                ref_audio_path: None,
                ref_transcript: None,
            },
        }],
        llm_config: LlmConfig {
            provider: "anthropic".into(),
            model: "claude-sonnet-4-6".into(),
            api_key_env: "ANTHROPIC_API_KEY".into(),
        },
    };
    let project_json = project_root.join("project.json");
    std::fs::write(&project_json, serde_json::to_string_pretty(&project).unwrap()).unwrap();

    // ── 2. Fountain parse smoke ──
    // Confirms the parser still hands back the right shape.
    let fountain = "INT. APARTMENT - NIGHT\n\nMIRA\nThe door is open.\n\nSFX: door creak, slow\n";
    let doc = parse_document(fountain);
    assert_eq!(doc.scenes.len(), 1, "fountain should produce one scene");
    assert_eq!(doc.characters, vec!["MIRA"], "fountain should discover MIRA");
    let blocks = &doc.scenes[0].blocks;
    assert_eq!(blocks.len(), 2, "fountain scene should have dialogue + SFX block");

    // ── 3. Generate fixture audio (replaces the inference servers) ──
    let assets_root = project_root.join("assets");
    std::fs::create_dir_all(&assets_root).unwrap();
    let dialogue_wav = assets_root.join("mira_take_1.wav");
    let sfx_wav = assets_root.join("door_creak.wav");
    let music_wav = assets_root.join("music_bed.wav");
    write_sine_wav(&dialogue_wav, 220, 4);
    write_sine_wav(&sfx_wav, 800, 1);
    write_sine_wav(&music_wav, 440, 8);

    // ── 4. Storyboard + two scenes ──
    let scene_one = Scene {
        id: Uuid::new_v4().to_string(),
        index: 0,
        slug: "00_apartment".into(),
        title: "Apartment".into(),
        description: String::new(),
        location: String::new(),
        characters: vec!["MIRA".into()],
        notes: String::new(),
        connects_from: None,
        connects_to: None,
        status: SceneStatus::Draft,
    };
    let scene_two = Scene {
        id: Uuid::new_v4().to_string(),
        index: 1,
        slug: "01_park".into(),
        title: "Park".into(),
        description: String::new(),
        location: String::new(),
        characters: vec!["MIRA".into()],
        notes: String::new(),
        connects_from: None,
        connects_to: None,
        status: SceneStatus::Draft,
    };
    let storyboard = Storyboard { scenes: vec![scene_one.clone(), scene_two.clone()] };
    std::fs::write(
        project_root.join("storyboard.json"),
        serde_json::to_string_pretty(&storyboard).unwrap(),
    ).unwrap();

    // ── 5. script.csv per scene, exercising bus + ducking + master chain ──
    // Scene 1 has dialogue + SFX + music, so the dialogue-bus → sidechain
    // duck path runs. Scene 2 is dialogue + a trimmed clip (uses atrim).
    for slug in ["00_apartment", "01_park"] {
        std::fs::create_dir_all(project_root.join("scenes").join(slug).join("assets")).unwrap();
        std::fs::create_dir_all(project_root.join("scenes").join(slug).join("render")).unwrap();
    }

    // Build via blocks_to_rows so this exercises that path too
    let s1_rows: Vec<ScriptRow> = vec![
        ScriptRow {
            scene: "S01".into(), track: "mira".into(), track_type: "DIALOGUE".into(),
            character: "MIRA".into(), prompt: "the door is open".into(),
            file: dialogue_wav.to_string_lossy().into(), start_ms: "1000".into(), duration_ms: "4000".into(),
            ..make_blank_row()
        },
        ScriptRow {
            scene: "S01".into(), track: "FOLEY".into(), track_type: "SFX".into(),
            character: String::new(), prompt: "door creak".into(),
            file: sfx_wav.to_string_lossy().into(), start_ms: "500".into(), duration_ms: "1000".into(),
            pan: "-0.5".into(),
            ..make_blank_row()
        },
        ScriptRow {
            scene: "S01".into(), track: "MUSIC".into(), track_type: "MUSIC".into(),
            character: String::new(), prompt: "tense underscore".into(),
            file: music_wav.to_string_lossy().into(), start_ms: "0".into(), duration_ms: "8000".into(),
            ..make_blank_row()
        },
    ];
    crate::app_support::write_script_rows(
        &project_root.join("scenes").join("00_apartment").join("script.csv"),
        &s1_rows,
    ).unwrap();

    // Scene 2: a trimmed clip — atrim should cut the source short.
    let s2_rows: Vec<ScriptRow> = vec![
        ScriptRow {
            scene: "S02".into(), track: "mira".into(), track_type: "DIALOGUE".into(),
            character: "MIRA".into(), prompt: "trimmed".into(),
            file: dialogue_wav.to_string_lossy().into(), start_ms: "0".into(), duration_ms: "2000".into(),
            ..make_blank_row()
        },
    ];
    crate::app_support::write_script_rows(
        &project_root.join("scenes").join("01_park").join("script.csv"),
        &s2_rows,
    ).unwrap();

    // Use the parser-derived rows to make sure that path round-trips too
    let parser_rows = blocks_to_rows(blocks, "S99", |name| Some(format!("CHAR_{}", name)));
    assert_eq!(parser_rows.len(), 2);
    assert_eq!(parser_rows[0].track_type, "DIALOGUE");
    assert_eq!(parser_rows[0].character, "CHAR_MIRA");
    assert_eq!(parser_rows[1].track_type, "SFX");

    // ── 6. Render each scene and validate meta ──
    for slug in ["00_apartment", "01_park"] {
        let out = render_scene_with_projects_dir(&projects_dir, &project_id, slug, Some(-16.0))
            .await
            .unwrap_or_else(|e| panic!("render_scene({slug}) failed: {e}"));
        let render_path = PathBuf::from(&out);
        assert!(render_path.exists(), "render.wav for {slug} should exist");
        let meta_path = render_path.with_file_name("render.wav.meta.json");
        assert!(meta_path.exists(), "render meta for {slug} should exist");
        let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&meta_path).unwrap()).unwrap();
        assert!(meta["target_lufs"].as_f64().unwrap() == -16.0);
        // Just assert measurement happened — exact LUFS varies on short content
        assert!(meta.get("integrated_lufs").is_some());
        assert!(meta.get("true_peak_dbtp").is_some());
        assert!(meta.get("duration_seconds").and_then(|v| v.as_f64()).unwrap_or(0.0) > 0.0);
    }

    // Verify atrim took effect in scene 2: source is 4s, trim to 2s.
    // hound's `duration()` returns frames per channel (not interleaved
    // samples) so we don't divide by channels.
    let scene2_render = project_root.join("scenes").join("01_park").join("render.wav");
    let reader = hound::WavReader::open(&scene2_render).unwrap();
    let spec = reader.spec();
    let frames = reader.duration() as u64;
    let duration_ms = frames * 1000 / spec.sample_rate as u64;
    assert!(
        duration_ms >= 1800 && duration_ms <= 2400,
        "scene 2 atrim should produce ~2s render, got {}ms",
        duration_ms
    );

    // ── 7. Episode render ──
    let final_path = render_episode_with_projects_dir(&projects_dir, &project_id, 500, Some(-16.0), None)
        .await
        .unwrap_or_else(|e| panic!("render_episode failed: {e}"));
    let final_pb = PathBuf::from(&final_path);
    assert!(final_pb.exists(), "final.wav should exist");
    let final_meta_path = final_pb.with_file_name("final.wav.meta.json");
    assert!(final_meta_path.exists(), "final meta should exist");
    let final_meta: serde_json::Value = serde_json::from_slice(&std::fs::read(&final_meta_path).unwrap()).unwrap();
    let scene_slugs = final_meta["scene_slugs"].as_array().unwrap();
    assert_eq!(scene_slugs.len(), 2);
    assert_eq!(final_meta["crossfade_ms"].as_u64().unwrap(), 500);

    // Cleanup
    std::fs::remove_dir_all(&projects_dir).ok();
}
