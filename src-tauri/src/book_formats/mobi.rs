use super::*;
use std::collections::HashMap;

/// Pure-Rust parser for DRM-free `.mobi`, `.azw3` (KF8 / dual MOBI+KF8), and `.prc` books.
/// Supports PalmDOC LZ77 and HUFF/CDIC decompression, EXTH metadata, cover extraction,
/// embedded `<img recindex="...">` images, and UTF-8 / Windows-1252 / Shift-JIS encodings.
pub(in crate::epub_import) fn parse_mobi_book(
    path: &str,
    include_images: bool,
) -> Result<ParsedBook, String> {
    let data = std::fs::read(path).map_err(|e| format!("Failed to read MOBI/AZW3: {}", e))?;
    let records = parse_palmdb_records(&data)?;
    if records.is_empty() {
        return Err("MOBI/AZW3 file has no PalmDB records.".to_string());
    }

    let pdb_name = std::str::from_utf8(&data[..32.min(data.len())])
        .unwrap_or("")
        .trim_end_matches('\0')
        .trim()
        .replace('_', " ");

    // Parse primary header from record 0
    let primary_hdr = parse_mobi_header(records[0])?;
    if primary_hdr.encryption_type != 0 {
        return Err("This MOBI/AZW3 book is DRM-protected and cannot be opened.".to_string());
    }

    // If this is a dual MOBI+KF8 combo file (EXTH 121 points to a valid KF8 header record),
    // prefer the KF8 section when it is valid and unencrypted, else fall back to record 0.
    let (header_rec_idx, hdr) = if let Some(kf8_idx) = primary_hdr.kf8_boundary {
        if kf8_idx > 0 && kf8_idx < records.len() {
            match parse_mobi_header(records[kf8_idx]) {
                Ok(kf8_hdr) if kf8_hdr.encryption_type == 0 && kf8_hdr.text_record_count > 0 => {
                    (kf8_idx, kf8_hdr)
                }
                _ => (0, primary_hdr),
            }
        } else {
            (0, primary_hdr)
        }
    } else {
        (0, primary_hdr)
    };

    let huff_decoder = if hdr.compression == 17480 {
        let base_huff = hdr.huff_record_offset as usize;
        let huff_count = hdr.huff_record_count as usize;
        // In KF8 combo files, HUFF offset may be relative to 0 or to header_rec_idx
        let resolved_start = if base_huff < records.len() && records[base_huff].starts_with(b"HUFF") {
            base_huff
        } else if header_rec_idx + base_huff < records.len()
            && records[header_rec_idx + base_huff].starts_with(b"HUFF")
        {
            header_rec_idx + base_huff
        } else {
            return Err("MOBI/AZW3 HUFF/CDIC decompression table not found.".to_string());
        };
        if huff_count < 2 || resolved_start + huff_count > records.len() {
            return Err("Invalid MOBI/AZW3 HUFF/CDIC table range.".to_string());
        }
        Some(HuffCdicDecoder::new(&records[resolved_start..resolved_start + huff_count])?)
    } else {
        None
    };

    // Decompress text records
    let first_text = header_rec_idx + 1;
    let text_end = (first_text + hdr.text_record_count as usize).min(records.len());
    let mut raw_bytes = Vec::with_capacity((hdr.text_length as usize).min(32 * 1024 * 1024));

    for rec in &records[first_text..text_end] {
        let payload = strip_trailing_extra_data(rec, hdr.extra_data_flags);
        match hdr.compression {
            1 => raw_bytes.extend_from_slice(payload),
            2 => decompress_palmdoc_lz77(payload, &mut raw_bytes),
            17480 => {
                if let Some(ref dec) = huff_decoder {
                    dec.decompress(payload, &mut raw_bytes)?;
                }
            }
            other => {
                return Err(format!("Unsupported MOBI/AZW3 compression type: {}", other));
            }
        }
    }

    if hdr.text_length > 0 && (hdr.text_length as usize) < raw_bytes.len() {
        raw_bytes.truncate(hdr.text_length as usize);
    }

    let decoded_html = decode_mobi_text(&raw_bytes, hdr.text_encoding);
    if decoded_html.trim().is_empty() {
        return Err("MOBI/AZW3 book contains no readable text.".to_string());
    }

    // Resolve image base record (in combo files, images live after record 0's first_image_index)
    let first_img_idx = primary_hdr_image_base(&records, &hdr, header_rec_idx);

    let cover = extract_mobi_cover(&records, first_img_idx, hdr.cover_offset);

    let html_with_images = if include_images {
        inline_mobi_recindex_images(&decoded_html, &records, first_img_idx)
    } else {
        decoded_html.clone()
    };

    // Convert Kindle pagebreaks into <hr /> and sanitize via shared HTML sanitizer
    let normalized_html = html_with_images
        .replace("<mbp:pagebreak/>", "\n<hr />\n")
        .replace("<mbp:pagebreak />", "\n<hr />\n")
        .replace("<mbp:pagebreak>", "\n<hr />\n");

    let sanitized = sanitize_epub_html_inner(&normalized_html, "", path, None, None);
    let paragraphs = extract_paragraphs(&sanitized);
    if paragraphs.is_empty() {
        return Err("MOBI/AZW3 book opened, but no readable paragraphs were extracted.".to_string());
    }

    let title = hdr
        .exth_title
        .or(hdr.full_name)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| chapter_title_from_html(&decoded_html, path))
        .or_else(|| if pdb_name.is_empty() { None } else { Some(pdb_name) })
        .unwrap_or_else(|| file_stem_title(path, "Kindle Book"));

    let mut metadata_languages = Vec::new();
    if let Some(lang) = hdr.exth_language {
        metadata_languages.push(lang);
    } else if let Some(lang) = mobi_locale_to_lang(hdr.locale) {
        metadata_languages.push(lang.to_string());
    }

    let sections = split_paragraphs_into_sections(paragraphs, "mobi", "mobi", &title);

    Ok(ParsedBook {
        title,
        author: hdr.exth_author,
        series: None,
        series_position: None,
        metadata_languages,
        default_vertical: false,
        cover,
        sections,
    })
}

struct MobiHeaderInfo {
    compression: u16,
    text_length: u32,
    text_record_count: u16,
    encryption_type: u16,
    text_encoding: u32,
    full_name: Option<String>,
    locale: u32,
    first_image_index: u32,
    huff_record_offset: u32,
    huff_record_count: u32,
    extra_data_flags: u16,
    exth_title: Option<String>,
    exth_author: Option<String>,
    exth_language: Option<String>,
    cover_offset: Option<u32>,
    kf8_boundary: Option<usize>,
}

fn read_be_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_be_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn parse_palmdb_records(data: &[u8]) -> Result<Vec<&[u8]>, String> {
    if data.len() < 78 {
        return Err("File is too small to be a valid MOBI/AZW3 PalmDB archive.".to_string());
    }
    let num_records = read_be_u16(data, 76).unwrap_or(0) as usize;
    if num_records == 0 {
        return Err("PalmDB header reports 0 records.".to_string());
    }
    let table_end = 78 + num_records * 8;
    if table_end > data.len() {
        return Err("Truncated PalmDB record table.".to_string());
    }

    let mut offsets = Vec::with_capacity(num_records);
    for i in 0..num_records {
        let off = read_be_u32(data, 78 + i * 8).unwrap_or(0) as usize;
        offsets.push(off);
    }

    let mut records = Vec::with_capacity(num_records);
    for i in 0..num_records {
        let start = offsets[i];
        let end = if i + 1 < num_records {
            offsets[i + 1]
        } else {
            data.len()
        };
        if start <= end && end <= data.len() {
            records.push(&data[start..end]);
        } else {
            records.push(&[]);
        }
    }
    Ok(records)
}

fn parse_mobi_header(rec0: &[u8]) -> Result<MobiHeaderInfo, String> {
    if rec0.len() < 16 {
        return Err("MOBI record 0 is too short.".to_string());
    }
    let compression = read_be_u16(rec0, 0).unwrap_or(1);
    let text_length = read_be_u32(rec0, 4).unwrap_or(0);
    let text_record_count = read_be_u16(rec0, 8).unwrap_or(0);
    let encryption_type = read_be_u16(rec0, 12).unwrap_or(0);

    let mut info = MobiHeaderInfo {
        compression,
        text_length,
        text_record_count,
        encryption_type,
        text_encoding: 65001,
        full_name: None,
        locale: 0,
        first_image_index: u32::MAX,
        huff_record_offset: 0,
        huff_record_count: 0,
        extra_data_flags: 0,
        exth_title: None,
        exth_author: None,
        exth_language: None,
        cover_offset: None,
        kf8_boundary: None,
    };

    if rec0.len() < 32 || &rec0[16..20] != b"MOBI" {
        // Legacy PalmDOC file without MOBI header
        return Ok(info);
    }

    let header_len = read_be_u32(rec0, 20).unwrap_or(0) as usize;
    info.text_encoding = read_be_u32(rec0, 28).unwrap_or(65001);

    if rec0.len() >= 96 {
        let fn_off = read_be_u32(rec0, 84).unwrap_or(0) as usize;
        let fn_len = read_be_u32(rec0, 88).unwrap_or(0) as usize;
        if fn_len > 0 && fn_off + fn_len <= rec0.len() {
            let name = decode_mobi_text(&rec0[fn_off..fn_off + fn_len], info.text_encoding);
            let trimmed = name.trim_matches('\0').trim().to_string();
            if !trimmed.is_empty() {
                info.full_name = Some(trimmed);
            }
        }
        info.locale = read_be_u32(rec0, 92).unwrap_or(0);
    }

    if rec0.len() >= 120 {
        info.first_image_index = read_be_u32(rec0, 108).unwrap_or(u32::MAX);
        info.huff_record_offset = read_be_u32(rec0, 112).unwrap_or(0);
        info.huff_record_count = read_be_u32(rec0, 116).unwrap_or(0);
    }

    if header_len >= 228 && rec0.len() >= 244 {
        info.extra_data_flags = read_be_u16(rec0, 242).unwrap_or(0);
    }

    let exth_flags = read_be_u32(rec0, 128).unwrap_or(0);
    let exth_start = 16 + header_len;
    if (exth_flags & 0x40) != 0 && exth_start + 12 <= rec0.len() && &rec0[exth_start..exth_start + 4] == b"EXTH" {
        let record_count = read_be_u32(rec0, exth_start + 8).unwrap_or(0) as usize;
        let mut cursor = exth_start + 12;
        let mut authors: Vec<String> = Vec::new();
        for _ in 0..record_count.min(256) {
            if cursor + 8 > rec0.len() {
                break;
            }
            let rec_type = read_be_u32(rec0, cursor).unwrap_or(0);
            let rec_len = read_be_u32(rec0, cursor + 4).unwrap_or(0) as usize;
            if rec_len < 8 || cursor + rec_len > rec0.len() {
                break;
            }
            let val_bytes = &rec0[cursor + 8..cursor + rec_len];
            match rec_type {
                100 => {
                    let a = decode_mobi_text(val_bytes, info.text_encoding).trim().to_string();
                    if !a.is_empty() && !authors.contains(&a) {
                        authors.push(a);
                    }
                }
                121 if val_bytes.len() == 4 => {
                    let b = read_be_u32(val_bytes, 0).unwrap_or(u32::MAX);
                    if b != u32::MAX {
                        info.kf8_boundary = Some(b as usize);
                    }
                }
                201 if val_bytes.len() == 4 => {
                    let off = read_be_u32(val_bytes, 0).unwrap_or(u32::MAX);
                    if off != u32::MAX {
                        info.cover_offset = Some(off);
                    }
                }
                503 => {
                    let t = decode_mobi_text(val_bytes, info.text_encoding).trim().to_string();
                    if !t.is_empty() {
                        info.exth_title = Some(t);
                    }
                }
                524 => {
                    let l = decode_mobi_text(val_bytes, info.text_encoding).trim().to_string();
                    if !l.is_empty() {
                        info.exth_language = Some(l);
                    }
                }
                _ => {}
            }
            cursor += rec_len;
        }
        if !authors.is_empty() {
            info.exth_author = Some(authors.join(", "));
        }
    }

    Ok(info)
}

/// Strips trailing extra-data entries (bit 1..15 variable-width integers, bit 0 multibyte overlap)
/// from a MOBI/KF8 compressed text record before decompression.
fn strip_trailing_extra_data(mut rec: &[u8], flags: u16) -> &[u8] {
    if flags == 0 || rec.is_empty() {
        return rec;
    }
    let mut bit = 15u16;
    while bit >= 1 {
        if (flags & (1 << bit)) != 0 {
            let size = read_trailing_vwi(rec);
            if size > 0 && size <= rec.len() {
                rec = &rec[..rec.len() - size];
            }
        }
        bit -= 1;
    }
    if (flags & 1) != 0 && !rec.is_empty() {
        let overlap = ((rec[rec.len() - 1] & 0x03) as usize) + 1;
        if overlap <= rec.len() {
            rec = &rec[..rec.len() - overlap];
        }
    }
    rec
}

fn read_trailing_vwi(bytes: &[u8]) -> usize {
    let mut value = 0usize;
    let mut shift = 0u32;
    let mut i = bytes.len();
    while i > 0 && shift < 28 {
        i -= 1;
        let b = bytes[i];
        value |= ((b & 0x7F) as usize) << shift;
        if (b & 0x80) != 0 {
            break;
        }
        shift += 7;
    }
    value
}

fn decompress_palmdoc_lz77(input: &[u8], out: &mut Vec<u8>) {
    let mut i = 0usize;
    while i < input.len() {
        let b = input[i];
        i += 1;
        match b {
            0x00 => out.push(0x00),
            0x01..=0x08 => {
                let count = b as usize;
                let end = (i + count).min(input.len());
                out.extend_from_slice(&input[i..end]);
                i = end;
            }
            0x09..=0x7F => out.push(b),
            0x80..=0xBF => {
                if i >= input.len() {
                    break;
                }
                let next = input[i];
                i += 1;
                let pair = (((b as u16) << 8) | (next as u16)) & 0x3FFF;
                let distance = (pair >> 3) as usize;
                let length = ((pair & 0x07) as usize) + 3;
                if distance > 0 && distance <= out.len() {
                    for _ in 0..length {
                        let idx = out.len() - distance;
                        let copied = out[idx];
                        out.push(copied);
                    }
                }
            }
            0xC0..=0xFF => {
                out.push(b' ');
                out.push(b ^ 0x80);
            }
        }
    }
}

struct HuffCdicDecoder {
    dict1: Vec<(u8, bool, u32)>,
    mincode: [u32; 33],
    maxcode: [u32; 33],
    dictionary: Vec<(Vec<u8>, bool)>,
    code_length: u32,
}

impl HuffCdicDecoder {
    fn new(huff_records: &[&[u8]]) -> Result<Self, String> {
        let huff = huff_records[0];
        if huff.len() < 24 || &huff[0..4] != b"HUFF" {
            return Err("Invalid HUFF header in MOBI/AZW3.".to_string());
        }
        let off1 = read_be_u32(huff, 16).unwrap_or(0) as usize;
        let off2 = read_be_u32(huff, 20).unwrap_or(0) as usize;
        if off1 + 256 * 4 > huff.len() || off2 + 64 * 4 > huff.len() {
            return Err("Truncated HUFF lookup tables.".to_string());
        }

        let mut dict1 = Vec::with_capacity(256);
        for i in 0..256 {
            let v = read_be_u32(huff, off1 + i * 4).unwrap_or(0);
            let codelen = (v & 0x1F) as u8;
            let term = (v & 0x80) != 0;
            let maxcode = v >> 8;
            dict1.push((codelen, term, maxcode));
        }

        let mut mincode = [0u32; 33];
        let mut maxcode = [0u32; 33];
        for i in 1..=32 {
            let min_raw = read_be_u32(huff, off2 + (i - 1) * 8).unwrap_or(0);
            let max_raw = read_be_u32(huff, off2 + (i - 1) * 8 + 4).unwrap_or(0);
            mincode[i] = min_raw << (32 - i);
            maxcode[i] = ((max_raw.wrapping_add(1)) << (32 - i)).wrapping_sub(1);
        }

        let mut dictionary: Vec<(Vec<u8>, bool)> = Vec::new();
        let mut code_length = 0u32;
        for cdic in &huff_records[1..] {
            if cdic.len() < 16 || &cdic[0..4] != b"CDIC" {
                continue;
            }
            let phrases = read_be_u32(cdic, 8).unwrap_or(0) as usize;
            let bits = read_be_u32(cdic, 12).unwrap_or(0);
            if code_length == 0 {
                code_length = bits;
            }
            let n = (1usize << bits).min(phrases.saturating_sub(dictionary.len()));
            for i in 0..n {
                let off_pos = 16 + i * 2;
                let Some(entry_off) = read_be_u16(cdic, off_pos) else {
                    break;
                };
                let start = 16 + entry_off as usize;
                let Some(blen) = read_be_u16(cdic, start) else {
                    break;
                };
                let slice_len = (blen & 0x7FFF) as usize;
                let flag = (blen & 0x8000) != 0;
                if start + 2 + slice_len <= cdic.len() {
                    dictionary.push((cdic[start + 2..start + 2 + slice_len].to_vec(), flag));
                } else {
                    dictionary.push((Vec::new(), true));
                }
            }
        }

        Ok(Self {
            dict1,
            mincode,
            maxcode,
            dictionary,
            code_length,
        })
    }

    fn decompress(&self, input: &[u8], out: &mut Vec<u8>) -> Result<(), String> {
        let mut bits_left = (input.len() as i64) * 8;
        let mut pos = 0usize;
        let mut x: u64 = read_u64_padded(input, 0);
        let mut n: i32 = 32;
        let _ = self.code_length;

        let mut stack_depth = 0usize;
        self.unpack_slice(input, &mut bits_left, &mut pos, &mut x, &mut n, out, &mut stack_depth)
    }

    #[allow(clippy::too_many_arguments)]
    fn unpack_slice(
        &self,
        input: &[u8],
        bits_left: &mut i64,
        pos: &mut usize,
        x: &mut u64,
        n: &mut i32,
        out: &mut Vec<u8>,
        depth: &mut usize,
    ) -> Result<(), String> {
        if *depth > 32 {
            return Err("HUFF/CDIC recursion limit exceeded.".to_string());
        }
        *depth += 1;

        while *bits_left > 0 {
            if *n <= 0 {
                *pos += 4;
                *x = read_u64_padded(input, *pos);
                *n += 32;
            }
            let code = ((*x >> (*n as u32)) & 0xFFFF_FFFF) as u32;
            let (mut codelen, term, mut maxcode) = self.dict1[(code >> 24) as usize];
            if !term {
                while (codelen as usize) < 32 && code < self.mincode[codelen as usize] {
                    codelen += 1;
                }
                maxcode = self.maxcode[codelen as usize];
            } else {
                maxcode = ((maxcode.wrapping_add(1)) << (32 - codelen as u32)).wrapping_sub(1);
            }
            if codelen == 0 {
                break;
            }
            *n -= codelen as i32;
            *bits_left -= codelen as i64;
            if *bits_left < 0 {
                break;
            }

            let r = (maxcode.wrapping_sub(code)) >> (32 - codelen as u32);
            let Some((slice, flag)) = self.dictionary.get(r as usize) else {
                break;
            };
            if *flag {
                out.extend_from_slice(slice);
            } else {
                let mut sub_bits = (slice.len() as i64) * 8;
                let mut sub_pos = 0usize;
                let mut sub_x = read_u64_padded(slice, 0);
                let mut sub_n = 32i32;
                self.unpack_slice(slice, &mut sub_bits, &mut sub_pos, &mut sub_x, &mut sub_n, out, depth)?;
            }
        }

        *depth -= 1;
        Ok(())
    }
}

fn read_u64_padded(bytes: &[u8], offset: usize) -> u64 {
    let mut buf = [0u8; 8];
    for (i, slot) in buf.iter_mut().enumerate() {
        if let Some(&b) = bytes.get(offset + i) {
            *slot = b;
        }
    }
    u64::from_be_bytes(buf)
}

fn decode_mobi_text(bytes: &[u8], encoding_code: u32) -> String {
    match encoding_code {
        65001 => String::from_utf8_lossy(bytes).into_owned(),
        1252 => encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned(),
        932 => encoding_rs::SHIFT_JIS.decode(bytes).0.into_owned(),
        _ => decode_text_bytes(bytes),
    }
}

fn mobi_locale_to_lang(locale: u32) -> Option<&'static str> {
    match locale & 0xFF {
        0x11 => Some("ja"),
        0x09 => Some("en"),
        0x19 => Some("ru"),
        0x07 => Some("de"),
        0x0C => Some("fr"),
        0x0A => Some("es"),
        _ => None,
    }
}

fn primary_hdr_image_base(records: &[&[u8]], hdr: &MobiHeaderInfo, header_rec_idx: usize) -> Option<usize> {
    let candidate = hdr.first_image_index;
    if candidate != u32::MAX && (candidate as usize) < records.len() {
        return Some(candidate as usize);
    }
    // Fallback: look at record 0's first_image_index when reading from KF8 boundary
    if header_rec_idx > 0 {
        if let Ok(rec0_hdr) = parse_mobi_header(records[0]) {
            if rec0_hdr.first_image_index != u32::MAX && (rec0_hdr.first_image_index as usize) < records.len() {
                return Some(rec0_hdr.first_image_index as usize);
            }
        }
    }
    None
}

fn is_likely_image_record(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
        || bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47])
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || (bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

fn extract_mobi_cover(
    records: &[&[u8]],
    first_img_idx: Option<usize>,
    cover_offset: Option<u32>,
) -> Option<String> {
    let base = first_img_idx?;
    if let Some(off) = cover_offset {
        let idx = base + off as usize;
        if let Some(rec) = records.get(idx) {
            if is_likely_image_record(rec) {
                let mime = infer_image_mime(rec, None);
                if let Some(url) = encode_data_url(rec, mime) {
                    return Some(url);
                }
            }
        }
    }
    for rec in records.iter().skip(base).take(8) {
        if is_likely_image_record(rec) {
            let mime = infer_image_mime(rec, None);
            if let Some(url) = encode_data_url(rec, mime) {
                return Some(url);
            }
        }
    }
    None
}

fn inline_mobi_recindex_images(html: &str, records: &[&[u8]], first_img_idx: Option<usize>) -> String {
    let Some(base) = first_img_idx else {
        return html.to_string();
    };
    let mut cache: HashMap<usize, String> = HashMap::new();
    let mut out = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(img_rel) = rest.to_ascii_lowercase().find("<img") {
        out.push_str(&rest[..img_rel]);
        let after_img = &rest[img_rel..];
        let Some(tag_end) = after_img.find('>') else {
            out.push_str(after_img);
            return out;
        };
        let tag = &after_img[..=tag_end];
        rest = &after_img[tag_end + 1..];

        if let Some(rec_str) = xml_attr(tag, "recindex") {
            if let Ok(rec_num) = rec_str.trim().parse::<usize>() {
                if rec_num >= 1 {
                    let target = base + rec_num - 1;
                    let url = if let Some(cached) = cache.get(&target) {
                        Some(cached.clone())
                    } else if cache.len() < MAX_EPUB_IMAGES_PER_CHAPTER {
                        records.get(target).and_then(|rec| {
                            if is_likely_image_record(rec) {
                                let mime = infer_image_mime(rec, None);
                                encode_data_url(rec, mime).map(|u| {
                                    cache.insert(target, u.clone());
                                    u
                                })
                            } else {
                                None
                            }
                        })
                    } else {
                        None
                    };
                    if let Some(data_url) = url {
                        let alt = xml_attr(tag, "alt")
                            .map(|a| format!(" alt=\"{}\"", escape_html_text(&a)))
                            .unwrap_or_default();
                        out.push_str(&format!("<img src=\"{}\"{} />", data_url, alt));
                        continue;
                    }
                }
            }
        }
        out.push_str(tag);
    }

    out.push_str(rest);
    out
}
