// Generate the vendored grammar and parity fixtures from the supplied Yomitan checkout.
// Runtime builds use the generated files and do not need Node or the checkout.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';

const root = path.resolve(process.argv[2] || 'yomitan-master/yomitan-master');
const {japaneseTransforms: descriptor} = await import(pathToFileURL(path.join(root, 'ext/js/language/ja/japanese-transforms.js')));
const {LanguageTransformer} = await import(pathToFileURL(path.join(root, 'ext/js/language/language-transformer.js')));
const transformer = new LanguageTransformer();
transformer.addDescriptor(descriptor);
const flags = (names) => transformer.getConditionFlagsFromConditionTypes(names) >>> 0;
const rules = [];
for (const [id, transform] of Object.entries(descriptor.transforms)) {
    for (const rule of transform.rules) {
        if (!['suffix', 'wholeWord'].includes(rule.type)) throw new Error(`Unsupported rule: ${rule.type}`);
        const input = rule.isInflected.source.replace(/^\^/, '').replace(/\$$/, '');
        // Japanese rules currently use literal suffixes, not arbitrary regexes.
        if (/[\\[\]().*+?{}|]/u.test(input)) throw new Error(`Nonliteral rule: ${input}`);
        rules.push({id, name: transform.name, description: transform.description || '', input,
            output: rule.deinflect(input), whole: rule.type === 'wholeWord',
            conditions_in: flags(rule.conditionsIn), conditions_out: flags(rule.conditionsOut)});
    }
}
const pos = Object.fromEntries(Object.entries(descriptor.conditions)
    .filter(([, value]) => value.isDictionaryForm).map(([name]) => [name, flags([name])]));
const data = {source: 'Yomitan japanese-transforms.js; GPL-3.0-or-later', pos, rules};
fs.writeFileSync('src-tauri/src/yomitan-japanese.json', JSON.stringify(data) + '\n');

const testsSource = fs.readFileSync(path.join(root, 'test/language/japanese-transforms.test.js'), 'utf8');
const categories = vm.runInNewContext(testsSource.slice(testsSource.indexOf('const tests = ['), testsSource.indexOf('const languageTransformer =')) + '\ntests;');
const fixtures = categories.flatMap(({valid, tests}) => tests.map(({term, source, rule, reasons}) => ({
    term, source, conditions: rule == null ? null : flags([rule]), reasons, valid,
})));
fs.writeFileSync('tests/yomitan-japanese-parity.json', JSON.stringify(fixtures) + '\n');
fs.mkdirSync('licenses', {recursive: true});
fs.copyFileSync(path.join(root, 'LICENSE'), 'licenses/Yomitan-GPL-3.0.txt');
console.log(`Generated ${rules.length} rules, ${fixtures.length} upstream parity cases.`);

const japanese = await import(pathToFileURL(path.join(root, 'ext/js/language/ja/japanese.js')));
const kana = {};
for (let code = 0xff61; code <= 0xff9f; code++) {
    for (const mark of ['', '\uff9e', '\uff9f']) {
        const source = String.fromCharCode(code) + mark;
        const result = japanese.convertHalfWidthKanaToFullWidth(source);
        if (source !== result) kana[source] = result;
    }
}
for (let code = 0x3040; code <= 0x30ff; code++) {
    for (const mark of ['\u3099', '\u309a']) {
        const source = String.fromCharCode(code) + mark;
        const result = japanese.normalizeCombiningCharacters(source);
        if (source !== result) kana[source] = result;
    }
}
fs.writeFileSync('src-tauri/src/yomitan-kana.json', JSON.stringify(kana) + '\n');
