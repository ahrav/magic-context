//!
//! The second metadata check immediately precedes reading to narrow the path-swap window.
//!

use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const PROJECT_DOC_FILES: [&str; 2] = ["ARCHITECTURE.md", "STRUCTURE.md"];
const PROJECT_DOCS_DELIMITER: &str = "\n\n---\n\n";
const MAX_PROJECT_DOC_BYTES: u64 = 256 * 1024;

/// Both fields are empty when neither configured document is included.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectDocs {
    pub rendered_block: String,
    pub canonical_hash: String,
}

fn canonicalize_doc_content(raw: &str) -> String {
    let no_bom = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lf = no_bom.replace("\r\n", "\n");
    let trimmed_lines: Vec<&str> = lf
        .split('\n')
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect();
    let joined = trimmed_lines.join("\n");
    joined.trim_end_matches('\n').to_string()
}

fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Returns `None` unless both metadata checks identify a regular file no larger than `MAX_PROJECT_DOC_BYTES`; a path swap can still change the file read.
fn read_safe_canonical(path: &Path) -> Option<String> {
    // `symlink_metadata` does not follow symlinks.
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_PROJECT_DOC_BYTES {
        return None;
    }
    // A second metadata check narrows the interval in which a path swap can bypass the initial check.
    // `fs::read_to_string` follows symlinks, so the second metadata check only narrows the race window.
    let meta2 = fs::symlink_metadata(path).ok()?;
    if !meta2.is_file() || meta2.len() > MAX_PROJECT_DOC_BYTES {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    Some(canonicalize_doc_content(&raw))
}

pub fn read_project_docs_canonical(project_directory: &str) -> ProjectDocs {
    let dir = Path::new(project_directory);
    let mut hash_pieces: Vec<String> = Vec::new();
    let mut rendered_sections: Vec<String> = Vec::new();

    for filename in PROJECT_DOC_FILES {
        let path = dir.join(filename);
        let Some(canonical) = read_safe_canonical(&path) else {
            continue;
        };
        hash_pieces.push(format!("file:{filename}\n{canonical}"));
        rendered_sections.push(format!(
            "<file name=\"{}\">\n{}\n</file>",
            escape_xml_attr(filename),
            escape_xml_content(&canonical)
        ));
    }

    let canonical_hash = if hash_pieces.is_empty() {
        String::new()
    } else {
        let mut hasher = Sha256::new();
        hasher.update(hash_pieces.join(PROJECT_DOCS_DELIMITER).as_bytes());
        format!("{:x}", hasher.finalize())
    };
    let rendered_block = if rendered_sections.is_empty() {
        String::new()
    } else {
        format!(
            "<project-docs>\n{}\n</project-docs>",
            rendered_sections.join("\n\n")
        )
    };

    ProjectDocs {
        rendered_block,
        canonical_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::io::Write;

    fn write_doc(dir: &Path, name: &str, body: &str) {
        let mut f = fs::File::create(dir.join(name)).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn empty_when_no_docs() {
        let dir = tempfile::tempdir().unwrap();
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert_eq!(docs, ProjectDocs::default());
    }

    #[test]
    fn renders_and_hashes_both_docs() {
        let dir = tempfile::tempdir().unwrap();
        write_doc(dir.path(), "ARCHITECTURE.md", "# Arch\nbody");
        write_doc(dir.path(), "STRUCTURE.md", "# Struct\nlayout");
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert!(docs
            .rendered_block
            .starts_with("<project-docs>\n<file name=\"ARCHITECTURE.md\">"));
        assert!(docs.rendered_block.contains("<file name=\"STRUCTURE.md\">"));
        assert_eq!(docs.canonical_hash.len(), 64, "sha256 hex");
    }

    #[test]
    fn canonicalization_normalizes_bom_crlf_trailing() {
        let dir = tempfile::tempdir().unwrap();
        write_doc(
            dir.path(),
            "ARCHITECTURE.md",
            "\u{feff}line1  \r\nline2\t\n\n\n",
        );
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert!(
            docs.rendered_block.contains(">\nline1\nline2\n<"),
            "{}",
            docs.rendered_block
        );
    }

    #[test]
    fn symlinked_doc_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        write_doc(dir.path(), "secret.txt", "TOP SECRET");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, dir.path().join("ARCHITECTURE.md")).unwrap();
        // A symlinked `ARCHITECTURE.md` is skipped; a regular `STRUCTURE.md` is included only when it is no larger than `MAX_PROJECT_DOC_BYTES` and can be read as UTF-8.
        write_doc(dir.path(), "STRUCTURE.md", "real struct");
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        #[cfg(unix)]
        {
            assert!(
                !docs.rendered_block.contains("TOP SECRET"),
                "symlink exfil blocked"
            );
            assert!(docs.rendered_block.contains("real struct"));
        }
    }

    #[test]
    fn oversized_doc_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x".repeat((MAX_PROJECT_DOC_BYTES + 1) as usize);
        write_doc(dir.path(), "ARCHITECTURE.md", &big);
        write_doc(dir.path(), "STRUCTURE.md", "small");
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert!(!docs.rendered_block.contains(&big));
        assert!(docs.rendered_block.contains("small"));
    }

    #[derive(Deserialize)]
    struct DocCase {
        files: Vec<(String, String)>, // (filename, raw body)
        rendered_block: String,
        canonical_hash: String,
    }
    #[derive(Deserialize)]
    struct DocsGolden {
        cases: Vec<DocCase>,
    }

    #[test]
    fn project_docs_golden_matches_reference() {
        let raw = include_str!("../testdata/project-docs-golden.json");
        let golden: DocsGolden = serde_json::from_str(raw).expect("parse project-docs-golden.json");
        assert!(!golden.cases.is_empty());
        for (n, case) in golden.cases.iter().enumerate() {
            let dir = tempfile::tempdir().unwrap();
            for (name, body) in &case.files {
                write_doc(dir.path(), name, body);
            }
            let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
            assert_eq!(
                docs.rendered_block, case.rendered_block,
                "render mismatch case {n}"
            );
            assert_eq!(
                docs.canonical_hash, case.canonical_hash,
                "hash mismatch case {n}"
            );
        }
    }
}
