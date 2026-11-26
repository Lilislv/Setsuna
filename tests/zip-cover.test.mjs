import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
    findEpubCoverPath,
    parseCentralDirectory,
    parseZipTail,
    pickMangaCoverEntry,
    readZipBookCover,
} from "../src/features/epub/zipCover.ts";

// Minimal zip writer (CRC is not checked by the reader).
function buildZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const { name, data, deflate } of files) {
        const nameBytes = Buffer.from(name, "utf8");
        const raw = Buffer.from(data);
        const body = deflate ? deflateRawSync(raw) : raw;
        const extra = Buffer.alloc(name.length % 3 ? 7 : 0); // exercise local extra fields
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(deflate ? 8 : 0, 8);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(extra.length, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(deflate ? 8 : 0, 10);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, nameBytes, extra, body);
        centrals.push(central, nameBytes);
        offset += 30 + nameBytes.length + extra.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

function rangeReader(bytes) {
    const calls = [];
    const read = async (start, end) => {
        calls.push([start, end]);
        return bytes.subarray(start, Math.min(end, bytes.length));
    };
    return { read, calls };
}

const decode = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64").toString("utf8");

test("zip tail and central directory parse", () => {
    const zip = buildZip([{ name: "a.jpg", data: "A" }, { name: "dir/b.png", data: "BB", deflate: true }]);
    const loc = parseZipTail(zip, zip.length);
    assert.ok(loc);
    const entries = parseCentralDirectory(zip.subarray(loc.cdOffset, loc.cdOffset + loc.cdSize));
    assert.deepEqual(entries.map((e) => [e.name, e.method]), [["a.jpg", 0], ["dir/b.png", 8]]);
});

test("manga cover is the custom cover, else the first page in natural order", () => {
    const names = (list) => list.map((name) => ({ name, method: 0, compressedSize: 1, localOffset: 0 }));
    assert.equal(pickMangaCoverEntry(names(["p10.jpg", "p2.jpg", "p1.jpg", "__MACOSX/p0.jpg", ".hidden/p0.jpg", "vol.mokuro"])).name, "p1.jpg");
    assert.equal(pickMangaCoverEntry(names(["p1.jpg", ".setsuna-cover.png"])).name, ".setsuna-cover.png");
    assert.equal(pickMangaCoverEntry(names(["notes.txt"])), null);
});

test("readZipBookCover reads a manga page through ranges only", async () => {
    const big = "x".repeat(200_000);
    const zip = buildZip([
        { name: "vol/010.jpg", data: big, deflate: true },
        { name: "vol/002.jpg", data: "second" },
        { name: "vol/001.jpg", data: "first-page", deflate: true },
    ]);
    const { read, calls } = rangeReader(zip);
    const url = await readZipBookCover(read, zip.length, "manga");
    assert.ok(url.startsWith("data:image/jpeg;base64,"));
    assert.equal(decode(url), "first-page");
    assert.ok(calls.every(([s, e]) => e - s < 70_000), "never reads the whole file");
});

test("readZipBookCover follows the EPUB OPF to the cover image", async () => {
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
    const opf = `<package><metadata><meta name="cover" content="cov"/></metadata><manifest>
        <item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
        <item id="cov" href="../images/cover%20art.jpg" media-type="image/jpeg"/>
    </manifest></package>`;
    const zip = buildZip([
        { name: "mimetype", data: "application/epub+zip" },
        { name: "META-INF/container.xml", data: container, deflate: true },
        { name: "OEBPS/content.opf", data: opf, deflate: true },
        { name: "images/cover art.jpg", data: "cover-bytes", deflate: true },
    ]);
    const { read } = rangeReader(zip);
    assert.equal(decode(await readZipBookCover(read, zip.length, "epub")), "cover-bytes");
});

test("findEpubCoverPath supports EPUB 3 cover-image and name guesses", () => {
    assert.equal(findEpubCoverPath("item/standard.opf",
        `<manifest><item properties="cover-image" id="x" href="image/c.jpg" media-type="image/jpeg"/></manifest>`), "item/image/c.jpg");
    assert.equal(findEpubCoverPath("content.opf",
        `<manifest><item id="img1" href="Images/Cover.png" media-type="image/png"/></manifest>`), "Images/Cover.png");
    assert.equal(findEpubCoverPath("content.opf", `<manifest></manifest>`), null);
});
