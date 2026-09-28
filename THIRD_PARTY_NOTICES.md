# Third-Party Notices

## Yomitan Japanese lookup grammar

The generated `src-tauri/src/yomitan-japanese.json`, `yomitan-kana.json`,
`tests/yomitan-japanese-parity.json` and the adapted transformer in
`src-tauri/src/japanese_deinflector.rs` derive from Yomitan.

Copyright (C) 2024-2026 Yomitan Authors.
The upstream test fixtures also include Copyright (C) 2020-2022 Yomichan Authors.
These portions are licensed under GPL-3.0-or-later; see
`licenses/Yomitan-GPL-3.0.txt` for the full license. The repository's MIT notice
does not replace the license of these portions.

Source: https://github.com/yomidevs/yomitan
Regenerate using `node scripts/generate-yomitan-japanese.mjs` against the supplied
Yomitan checkout. Runtime builds consume the checked-in data without that checkout.

## Ve text segmentation rules

Setsuna's Japanese word grouping is adapted from `ve_dart`, an MIT-licensed
Dart implementation of Ve used by Jidoujisho.

Copyright (c) 2021 Leo Rafael Orpilla

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: https://github.com/arianneorpilla/ve_dart

## Lindera

Setsuna uses the MIT-licensed Lindera morphological analyzer and its embedded
IPADIC support for Japanese tokenization. See the dependency sources bundled
by Cargo for their complete notices and dictionary licensing information.

Source: https://github.com/lindera/lindera
