import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { parseSubtitleFile, cueAt, sceneForCue, clipInterval } from "../src/features/player/model.ts";

test("subtitle parsing sorts cues, ignores bad intervals and keeps ASS dialogue commas", () => {
    const srt =
        "2\n00:00:08,500 --> 00:00:10,000\n後\n\n1\n00:00:00,000 --> 00:00:02,000\n先\n\n3\nbad --> 00:00:03,000\nx";
    const cues = parseSubtitleFile(srt, "ep.srt");
    assert.deepEqual(
        cues.map((c) => c.text),
        ["先", "後"],
    );
    assert.equal(cueAt(cues, 2), undefined);
    const ass =
        "[Events]\nFormat: Layer, Start, End, Text\nDialogue: 0,0:00:01.50,0:00:03.00,{\\i1}Hello, world\\N日本語";
    assert.equal(parseSubtitleFile(ass, "ep.ass")[0].text, "Hello, world\n日本語");
});

test("scene uses the media clock, includes five seconds before speech, clamps to both file boundaries", () => {
    const cue = { id: 1, start: 8, end: 12, text: "声" };
    const scene = sceneForCue("episode", cue, 2, 10);
    assert.deepEqual(clipInterval(scene, 5, 0.25), { start: 1, end: 10 });
    assert.deepEqual(clipInterval(sceneForCue("ep", { ...cue, start: 1, end: 2 }, 0, 10), 5, 0.25), {
        start: 0,
        end: 2.25,
    });
    assert.equal(sceneForCue("ep", cue, -5, 10), undefined);
});

const bundle = await build({
    entryPoints: ["src/features/player/mining.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
        {
            name: "mock-native",
            setup(b) {
                b.onResolve({ filter: /^@tauri-apps\// }, (args) => ({ path: args.path, namespace: "native" }));
                b.onLoad({ filter: /.*/, namespace: "native" }, () => ({
                    contents:
                        'export const invoke=(...args)=>globalThis.playerInvoke(...args); export const fetch=()=>{throw Error("unexpected network")};',
                }));
            },
        },
    ],
});
const { addPlayerNote } = await import(
    "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
);
const settings = {
    ankiModel: "Basic",
    ankiDeck: "Anime",
    ankiFieldWord: "Front",
    ankiFieldMeaning: "Back",
    ankiFieldAudio: "none",
};
const scene = { source: "episode.mp4", start: 12, end: 14, duration: 30 };

test("scene export stores original video on a Basic card and discards only its temporary file", async () => {
    globalThis.window = { __TAURI_INTERNALS__: {} };
    const calls = [];
    globalThis.playerInvoke = async (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd === "extract_player_clip")
            return { filename: "scene.mp4", path: "clips/scene.mp4", media_type: "video" };
        if (cmd === "player_scene_frame") return "frame-base64";
        if (cmd === "discard_player_clip") return;
        if (args.action === "modelFieldNames") return ["Front", "Back"];
        if (args.action === "storeMediaFile") return "stored.mp4";
        if (args.action === "addNote") return 123;
        throw Error(cmd);
    };
    assert.equal((await addPlayerNote(settings, { word: "言葉", meaning: "слово" }, scene)).result, 123);
    assert.deepEqual(calls[0][1], { sourcePath: "episode.mp4", start: 7, end: 14.25, preferVideo: true });
    assert.equal(
        calls.find(([, a]) => a.action === "addNote")[1].params.note.fields.Back,
        "слово [sound:stored.mp4]",
    );
    const note = calls.find(([, a]) => a.action === "addNote")[1].params.note;
    assert.deepEqual(note.picture[0].fields, ["Back"]);
    assert.equal(note.picture[0].data, "frame-base64");
    assert.deepEqual(calls.at(-1), ["discard_player_clip", { filename: "scene.mp4" }]);
});

test("encoder failure never creates a silent substitute card", async () => {
    let calls = 0;
    globalThis.playerInvoke = async (cmd) => {
        calls++;
        assert.equal(cmd, "extract_player_clip");
        throw Error("encoder missing");
    };
    assert.match((await addPlayerNote(settings, { word: "雪" }, scene)).error, /encoder missing/);
    assert.equal(calls, 1);
});
