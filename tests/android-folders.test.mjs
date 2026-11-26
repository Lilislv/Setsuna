import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
    stdin: {
        contents: "export * from './src/features/player/androidFolders'; export { matchSubtitlePaths, fileName } from './src/features/player/localMedia';",
        resolveDir: process.cwd(),
        loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
});
const { androidRoot, treeUriOf, folderFromScan, isAndroidFolderPath, matchSubtitlePaths, fileName } = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const tree = "content://com.android.externalstorage.documents/tree/primary%3AAnime";
const doc = (id) => `${tree}/document/${id}`;

test("a root keeps the tree URI and shows the folder's own name", () => {
    const root = androidRoot(tree, "Anime");
    assert.equal(isAndroidFolderPath(root), true);
    assert.equal(treeUriOf(root), tree);
    assert.equal(fileName(root), "Anime");
});

test("scan result becomes the desktop library shape with real file names", () => {
    const root = androidRoot(tree, "Anime");
    const seen = new Map();
    const folder = folderFromScan(root, {
        name: "Anime",
        directories: [{
            relative: "Frieren/Season 1",
            episodes: [{ name: "[Sub] Frieren - 01.mkv", uri: doc("e1"), size: 1 }],
            subtitles: [
                { name: "[Sub] Frieren - 01.ja.srt", uri: doc("s1"), size: 1 },
                { name: "Subs/[Sub] Frieren - 01.en.ass", uri: doc("s2"), size: 1 },
            ],
        }],
    }, (path, uri) => seen.set(path, uri));
    const [directory] = folder.directories;
    assert.equal(directory.path, `${root}/Frieren/Season 1`);
    assert.equal(fileName(directory.episodes[0].path), "[Sub] Frieren - 01.mkv");
    assert.equal(seen.get(directory.episodes[0].path), doc("e1"));
    assert.equal(seen.get(directory.subtitles[1]), doc("s2"));
    const [primary, translation] = matchSubtitlePaths(directory.episodes[0].path, directory.subtitles, false);
    assert.equal(fileName(primary), "[Sub] Frieren - 01.ja.srt");
    assert.equal(fileName(translation), "[Sub] Frieren - 01.en.ass");
});

test("slashes inside names can't break the virtual path", () => {
    const folder = folderFromScan(androidRoot(tree, "A/B"), {
        name: "A/B",
        directories: [{ relative: "", episodes: [{ name: "x\\y.mp4", uri: doc("e"), size: 1 }], subtitles: [] }],
    });
    assert.equal(fileName(folder.path), "A_B");
    assert.equal(fileName(folder.directories[0].episodes[0].path), "x_y.mp4");
});
