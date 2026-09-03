// Deterministic corpus generation shared by the scanner and redaction
// benches. Duplicated in both bench targets because Cargo bench targets
// cannot share a private module across crates.

/// Deterministic generator used to keep benchmark corpora reproducible.
pub struct Lcg(u64);

impl Lcg {
    /// Creates a generator, normalizing zero to the nonzero state `1`.
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    /// Advances the generator and returns its high-order output bits.
    pub fn next_u32(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.0 >> 33) as u32
    }

    /// Selects a deterministic element from a nonempty slice.
    ///
    /// # Panics
    ///
    /// Panics when `items` is empty.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[(self.next_u32() as usize) % items.len()]
    }
}

const PROSE_WORDS: &[&str] = &[
    "the", "quick", "brown", "fox", "jumps", "over", "lazy", "dog", "while", "reading", "logs",
    "from", "deploy", "pipeline", "stage", "output", "compile", "finished", "warning", "unused",
    "variable", "shadow", "request", "handler", "returned", "status", "duration", "millis",
];

/// Prose, code, and log shaped filler with no rule anchors.
pub fn zero_anchor(bytes: usize, seed: u64) -> String {
    let mut rng = Lcg::new(seed);
    let mut out = String::with_capacity(bytes + 64);
    while out.len() < bytes {
        for _ in 0..8 {
            out.push_str(rng.pick(PROSE_WORDS));
            out.push(' ');
        }
        out.push_str("line=");
        out.push_str(&rng.next_u32().to_string());
        out.push('\n');
    }
    out.truncate(floor_char_boundary(&out, bytes));
    out
}

/// Anchor-adjacent text that produces no findings: secret vocabulary with
/// scalar or safelisted values, and truncated token prefixes.
pub fn anchor_bait(bytes: usize, seed: u64) -> String {
    let mut rng = Lcg::new(seed);
    let bait: &[&str] = &[
        "token=12345",
        "password=true",
        "api_key=null",
        "monkey business as usual",
        "the keynote speaker arrived",
        "authentic reporting from the field",
        "AKIAZ was the flight code",
        "sk-ant is a prefix, nothing more",
        "secret: ***",
        "password=hunter2",
        "token=${GITHUB_TOKEN}",
        "credential_count=42",
    ];
    let mut out = String::with_capacity(bytes + 64);
    while out.len() < bytes {
        out.push_str(rng.pick(bait));
        out.push('\n');
        for _ in 0..4 {
            out.push_str(rng.pick(PROSE_WORDS));
            out.push(' ');
        }
        out.push('\n');
    }
    out.truncate(floor_char_boundary(&out, bytes));
    out
}

/// Secret-shaped lines that produce findings.
///
/// Credential shapes are assembled from fragments so no literal in this
/// file matches a secret detector; committing one would trip push
/// protection and teach the corpus to look like a real leak.
pub fn finding_dense(bytes: usize, seed: u64) -> String {
    let mut rng = Lcg::new(seed);
    let mut out = String::with_capacity(bytes + 128);
    let mut counter = 0u32;
    while out.len() < bytes {
        counter = counter.wrapping_add(1);
        let n = rng.next_u32();
        match counter % 5 {
            0 => {
                out.push_str("password=hunter7B9xQ");
                out.push_str(&n.to_string());
            }
            1 => {
                out.push_str("\"apiKey\": \"Sx9Kq2mB7Lw");
                out.push_str(&n.to_string());
                out.push('"');
            }
            2 => {
                out.push_str("github");
                out.push_str("_pat_11ABCDEFG0");
                out.push_str("abcdefghijklmnopqrstuvwxyz");
                out.push_str("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
                out.push_str("012345678901234");
                out.push_str(&(n % 10).to_string());
            }
            3 => {
                out.push_str("aws=AKIA");
                out.push_str("ABCDEFGHIJKLMN");
                out.push_str(match n % 4 {
                    0 => "OP",
                    1 => "QR",
                    2 => "ST",
                    _ => "UV",
                });
            }
            _ => {
                out.push_str("slack: xox");
                out.push_str("b-123456789012-");
                out.push_str("AbCdEfGhIjKlMnOp");
                out.push_str(&(n % 100).to_string());
            }
        }
        out.push('\n');
        for _ in 0..3 {
            out.push_str(rng.pick(PROSE_WORDS));
            out.push(' ');
        }
        out.push('\n');
    }
    out.truncate(floor_char_boundary(&out, bytes));
    out
}

/// Candidate storm: maximal candidate density per byte.
pub fn storm(bytes: usize) -> String {
    let mut out = String::with_capacity(bytes + 32);
    while out.len() < bytes {
        out.push_str("password=x password=hunter2 token=zz\n");
    }
    out.truncate(floor_char_boundary(&out, bytes));
    out
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}
