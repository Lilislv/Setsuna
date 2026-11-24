import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
    catalogEntries,
    cleanReleaseTitle,
    inferMediaTitle,
    rankPosters,
} from "../src/features/player/posterModel.ts";
import { suggestedEpisode } from "../src/features/player/libraryModel.ts";
import { matchSubtitlePaths } from "../src/features/player/localMedia.ts";
import { parseSubtitleFile, cueAt, nextCue, sceneForCue, clipInterval } from "../src/features/player/model.ts";

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

test("line navigation jumps to the neighboring cue even mid-line, and skips cues outside the media", () => {
    const cues = [
        [0, 1],
        [1, 3],
        [5, 7],
        [9, 11],
    ].map(([start, end], id) => ({ id, start, end, text: String(id) }));
    assert.equal(nextCue(cues, 5.5, -1, 1, 7)?.id, 1);
    assert.equal(nextCue(cues, 5.5, 1, 1, 7), undefined);
    assert.equal(nextCue(cues, 4, 1, 1, 7)?.id, 2);
    assert.equal(nextCue(cues, 4, -1, 3, 7), undefined);
});

test("dropped subtitle packs select Japanese first and never match the next episode number", () => {
    const paths = ["Series E01.ru.srt", "Series E01.ja.ass", "Series E010.ja.ass", "Series E02.srt"];
    assert.deepEqual(matchSubtitlePaths("series E01.MKV", paths, false), [paths[1], paths[0]]);
    assert.deepEqual(matchSubtitlePaths("series E02.mkv", paths, false), [paths[3], undefined]);
    assert.deepEqual(matchSubtitlePaths("series E03.mkv", paths, false), [undefined, undefined]);
    assert.deepEqual(matchSubtitlePaths("clip.mp4", ["different.vtt"], true), ["different.vtt", undefined]);
});

test("ASS removes vector paths and duplicate karaoke layers without dropping lyrics", () => {
    const ass = String.raw`[Events]
Format: Layer, Start, End, Text
Dialogue: 0,0:01:10.70,0:01:14.98,{\p1\pos(120,40)}m -7 0 b -7 -9 7 -9 7 0
Dialogue: 0,0:01:10.70,0:01:14.98,{\pos(120,40)\blur4}歌の言葉
Dialogue: 1,0:01:10.70,0:01:14.98,{\pos(120,40)\blur8}歌の言葉
Dialogue: 1,0:01:11.70,0:01:14.98,{\p1}m 1 2 l 3 4{\p0}台詞\hここ
Dialogue: 0,0:01:17.00,0:01:20.98,歌の言葉`;
    assert.deepEqual(
        parseSubtitleFile(ass, "karaoke.ass").map((cue) => cue.text),
        ["歌の言葉", "台詞 ここ", "歌の言葉"],
    );
});

test("library matches the episode across release groups and technical tags", () => {
    const first = "[Group] Watashi wo Tabetai, Hitodenashi - 01 [WebRip][1080p][JPN].ass";
    const second = "[Group] Watashi wo Tabetai, Hitodenashi - 02 [WebRip][1080p][JPN].ass";
    const russian = "Watashi wo Tabetai, Hitodenashi - 01.ru.ass";
    assert.deepEqual(
        matchSubtitlePaths(
            "Watashi wo Tabetai, Hitodenashi - 01 [1080p AVC EAC3] [AAC].mkv",
            [second, russian, first],
            false,
        ),
        [first, russian],
    );
});

test("library resumes legacy positions and advances after a completed episode", () => {
    const episodes = [{ path: "e1" }, { path: "e2" }, { path: "e3" }];
    assert.equal(suggestedEpisode(episodes, { e2: 60 }), 1);
    assert.equal(suggestedEpisode(episodes, { e2: { time: 0, lastPlayedAt: 100, completed: true } }), 2);
    assert.equal(
        suggestedEpisode(episodes, {
            e1: { time: 120, lastPlayedAt: 200 },
            e2: { time: 0, lastPlayedAt: 100, completed: true },
        }),
        0,
    );
});

test("poster queries remove release tags while retaining titles, numbering and useful years", () => {
    assert.deepEqual(cleanReleaseTitle("The.Matrix.1999.1080p.WEB-DL.mkv", true), {
        title: "The Matrix",
        year: 1999,
    });
    assert.deepEqual(cleanReleaseTitle("Blade Runner 2049 (2017) [UHD].mkv", true), {
        title: "Blade Runner 2049",
        year: 2017,
    });
    assert.deepEqual(cleanReleaseTitle("[Group] Watashi wo Tabetai, Hitodenashi - 01 [AAC].mkv", true), {
        title: "Watashi wo Tabetai, Hitodenashi",
    });
    assert.deepEqual(cleanReleaseTitle("Mr.Robot.2015.S01E01.1080p.mkv", true), { title: "Mr Robot", year: 2015 });
    const root = "D:/Watashi wo Tabetai, Hitodenashi [WEB-DL 1080p]";
    const directory = {
        path: root + "/AAC",
        episodes: [{ path: root + "/AAC/Watashi wo Tabetai, Hitodenashi - 01 [AAC].mkv" }],
        subtitles: [],
    };
    assert.equal(inferMediaTitle(directory, root).title, "Watashi wo Tabetai, Hitodenashi");
    assert.equal(cleanReleaseTitle("눈물의 여왕 S01E01.mkv", true).title, "눈물의 여왕");
});

test("movie folders can present separate films without splitting seasons", () => {
    const films = {
        path: "D:/Movies",
        episodes: [{ path: "D:/Movies/Metropolis (1927).mkv" }, { path: "D:/Movies/Paris, Texas (1984).mp4" }],
        subtitles: [],
    };
    assert.deepEqual(
        catalogEntries(films).map((item) => inferMediaTitle(item.directory, "D:/Movies").title),
        ["Metropolis", "Paris, Texas"],
    );
    assert.equal(
        catalogEntries({ ...films, episodes: [{ path: "Show S01E01.mkv" }, { path: "Show S01E02.mkv" }] }).length,
        1,
    );
});

test("poster suggestions rank same-name remakes by year and deduplicate IDs", () => {
    const a = { id: "old", title: "Shogun", year: 1980, imageUrl: "https://example.com/a.jpg" };
    const b = { id: "new", title: "Shogun", year: 2024, imageUrl: "https://example.com/b.jpg" };
    assert.deepEqual(
        rankPosters([a, b, b], "Shogun", 2024).map((p) => p.id),
        ["new", "old"],
    );
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
